import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import {
  diffCharBudget,
  fetchPreviousThreads,
  gatherPr,
  type Octokit,
  type PrRef,
} from "./context.js";
import { makeExploreTools } from "./explore.js";
import { fetchLinkedIssues, parseIssueRefs } from "./issues.js";
import {
  checkReasoningEffort,
  runStructured,
  type UsageBreakdown,
} from "./model.js";
import {
  buildReviewPrompt,
  buildSystemPrompt,
  loadBasePrompt,
  loadDefaultRules,
} from "./prompts.js";
import { planReview, submitReview, threadStatus } from "./review.js";
import { loadRules } from "./rules.js";
import {
  type Finding,
  type ReasoningEffort,
  reasoningEfforts,
  reviewOutputSchema,
  type Severity,
  severities,
} from "./schema.js";
import { fitSuggestion } from "./suggestions.js";
import { verifyFindings } from "./verify.js";
import { fetchReferencedWorkflows, parseWorkflowRefs } from "./workflows.js";

export interface Inputs {
  model: string;
  maxToolCalls: number;
  explorationTokenBudget: number;
  contextWindowTokens: number;
  reasoningEffort: ReasoningEffort | undefined;
  maxInlineComments: number;
  inlineSeverityThreshold: Severity;
  requestChangesThreshold: Severity;
  reviewerLogin: string;
  dryRun: boolean;
}

function severityInput(name: string, fallback: Severity): Severity {
  const raw = core.getInput(name) || fallback;
  if (!(severities as readonly string[]).includes(raw)) {
    throw new Error(
      `Input ${name} must be one of ${severities.join(", ")}, got "${raw}"`,
    );
  }
  return raw as Severity;
}

/** Unset keeps the model's own default reasoning level. */
function reasoningEffortInput(): ReasoningEffort | undefined {
  const raw = core.getInput("reasoning_effort");
  if (!raw) return undefined;
  if (!(reasoningEfforts as readonly string[]).includes(raw)) {
    throw new Error(
      `Input reasoning_effort must be one of ${reasoningEfforts.join(", ")}, got "${raw}"`,
    );
  }
  return raw as ReasoningEffort;
}

// Sized so a worst-case exploration stays a few dollars with caching on;
// typical reviews finish well under it.
const DEFAULT_TOKEN_BUDGET = 5_000_000;

/** One log line per phase; healthy caching shows uncached far below cache reads. */
function describeUsage(usage: UsageBreakdown): string {
  return (
    `${usage.noCache} uncached, ${usage.cacheRead} cache reads, ` +
    `${usage.cacheWrite} cache writes, ${usage.output} output`
  );
}

/**
 * Parses a numeric input. Empty input returns the fallback. A non-empty
 * value that is not a finite positive number throws, naming the input and
 * the bad value, so it never flows downstream as NaN.
 */
function numberInput(name: string, fallback: number): number {
  const raw = core.getInput(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Input ${name} must be a finite positive number, got "${raw}"`,
    );
  }
  return value;
}

/** Reads and validates all action inputs. */
export function readInputs(): Inputs {
  const model = core.getInput("model") || "claude-opus-4-8";
  const reasoningEffort = reasoningEffortInput();
  checkReasoningEffort(model, reasoningEffort);
  return {
    model,
    maxToolCalls: numberInput("max_tool_calls", 50),
    explorationTokenBudget: numberInput(
      "exploration_token_budget",
      DEFAULT_TOKEN_BUDGET,
    ),
    contextWindowTokens: numberInput("context_window_tokens", 200_000),
    reasoningEffort,
    maxInlineComments: numberInput("max_inline_comments", 15),
    inlineSeverityThreshold: severityInput(
      "inline_severity_threshold",
      "minor",
    ),
    requestChangesThreshold: severityInput(
      "request_changes_threshold",
      "major",
    ),
    reviewerLogin: core.getInput("reviewer_login"),
    dryRun: core.getInput("dry_run") === "true",
  };
}

interface WebhookPayload {
  pull_request?: { draft?: boolean };
  action?: string;
  requested_reviewer?: { login?: string };
}

/** Returns a skip reason, or null when the review should run. */
export function shouldSkip(
  payload: WebhookPayload,
  inputs: Inputs,
  eventName: string,
): string | null {
  if (payload.pull_request?.draft && eventName !== "workflow_dispatch") {
    return "PR is a draft; request a review again when it is ready";
  }
  if (
    payload.action === "review_requested" &&
    payload.requested_reviewer?.login !== undefined
  ) {
    if (!inputs.reviewerLogin) {
      return "reviewer_login is not set; set it to your machine account login to enable review_requested triggers";
    }
    const login = payload.requested_reviewer.login;
    if (login !== inputs.reviewerLogin) {
      return `review requested from ${login}, not from ${inputs.reviewerLogin}`;
    }
  }
  return null;
}

/** Copies credential inputs into the env vars the model providers read. */
export function exportApiKeys(): void {
  const anthropicKey = core.getInput("anthropic_api_key");
  if (anthropicKey) process.env.ANTHROPIC_API_KEY = anthropicKey;
  const openaiKey = core.getInput("openai_api_key");
  if (openaiKey) process.env.OPENAI_API_KEY = openaiKey;
  const compatBaseUrl = core.getInput("openai_compatible_base_url");
  if (compatBaseUrl) process.env.OPENAI_COMPATIBLE_BASE_URL = compatBaseUrl;
  const compatKey = core.getInput("openai_compatible_api_key");
  if (compatKey) process.env.OPENAI_COMPATIBLE_API_KEY = compatKey;
}

async function postFailureComment(octokit: Octokit, ref: PrRef): Promise<void> {
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${ref.owner}/${ref.repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
  await octokit.rest.issues.createComment({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: ref.pullNumber,
    body: `The AI review failed before producing a result. See the run log: ${runUrl}`,
  });
}

/** Full pipeline: guard, gather, phase 1, phase 2, compose, submit. */
export async function run(): Promise<void> {
  const inputs = readInputs();
  exportApiKeys();

  const skipReason = shouldSkip(
    context.payload as WebhookPayload,
    inputs,
    context.eventName,
  );
  if (skipReason) {
    core.info(`Skipping review: ${skipReason}`);
    return;
  }

  const pullNumber =
    (context.payload as { pull_request?: { number?: number } }).pull_request
      ?.number ?? Number(core.getInput("pull_number"));
  if (!pullNumber) {
    core.setFailed(
      "No pull request number available from the event or the pull_number input.",
    );
    return;
  }

  const token = core.getInput("github_token", { required: true });
  const octokit = getOctokit(token);
  const ref: PrRef = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pullNumber,
  };
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const actionRoot =
    process.env.GITHUB_ACTION_PATH ??
    join(dirname(fileURLToPath(import.meta.url)), "..");

  try {
    const pr = await gatherPr(
      octokit,
      ref,
      diffCharBudget(inputs.contextWindowTokens),
    );
    const rules = loadRules(workspace, pr.changedPaths);
    const previous = await fetchPreviousThreads(
      octokit,
      ref,
      [inputs.reviewerLogin, "github-actions[bot]"].filter(Boolean),
    );
    if (previous.length > 0) {
      const open = previous.filter(
        (t) => threadStatus(t, inputs.requestChangesThreshold) === "open",
      ).length;
      core.info(
        `Earlier review threads: ${previous.length} fetched (${open} open, ${previous.length - open} closed)`,
      );
    }
    const linkedIssues = await fetchLinkedIssues(
      octokit,
      parseIssueRefs(pr.meta.body, ref.owner, ref.repo),
    );
    if (linkedIssues.length > 0)
      core.info(`Linked issues: ${linkedIssues.length} fetched for context`);
    const referencedWorkflows = await fetchReferencedWorkflows(
      octokit,
      parseWorkflowRefs(pr.files),
    );
    if (referencedWorkflows.length > 0)
      core.info(
        `Referenced workflows: ${referencedWorkflows.length} fetched for context`,
      );

    const system = buildSystemPrompt(
      loadBasePrompt(actionRoot),
      loadDefaultRules(actionRoot),
      rules,
    );
    const tools = makeExploreTools(workspace);

    core.info(
      `Phase 1: reviewing with ${inputs.model} (rules source: ${rules.source})`,
    );
    const phase1 = await runStructured({
      modelId: inputs.model,
      system,
      prompt: buildReviewPrompt({
        meta: pr.meta,
        files: pr.files,
        skippedFiles: pr.skippedFiles,
        previous,
        requestChangesThreshold: inputs.requestChangesThreshold,
        linkedIssues,
        referencedWorkflows,
      }),
      schema: reviewOutputSchema,
      tools,
      maxToolCalls: inputs.maxToolCalls,
      tokenBudget: inputs.explorationTokenBudget,
      contextWindowTokens: inputs.contextWindowTokens,
      reasoningEffort: inputs.reasoningEffort,
    });
    core.info(
      `Phase 1 done: ${phase1.output.findings.length} candidate findings, ${phase1.toolCalls} tool calls`,
    );

    core.info(`Phase 1 tokens: ${describeUsage(phase1.usage)}`);

    const patches = new Map(pr.files.map((f) => [f.path, f.patch]));
    const findings = phase1.output.findings.map((f) => {
      const fit = fitSuggestion(f, patches.get(f.path));
      const range = (x: Finding) =>
        x.startLine !== undefined && x.startLine !== x.line
          ? `${x.startLine}-${x.line}`
          : `${x.line}`;
      if (fit.snapped) {
        core.info(
          `Range ${range(f)} moved to ${range(fit.finding)}, the block's edges match those lines: ${f.path}`,
        );
      }
      if (fit.dropped) {
        core.info(
          `Suggestion dropped, it only repeats the code it would replace: ${f.path}:${f.line}`,
        );
      } else if (fit.trimmed > 0) {
        core.info(
          `Suggestion trimmed, ${fit.trimmed} line(s) repeated the code around the range: ${f.path}:${f.line}`,
        );
      }
      return fit.finding;
    });

    core.info(`Phase 2: verifying ${findings.length} findings`);
    const phase2 = await verifyFindings({
      modelId: inputs.model,
      system,
      findings,
      previous,
      requestChangesThreshold: inputs.requestChangesThreshold,
      tools,
      contextWindowTokens: inputs.contextWindowTokens,
      reasoningEffort: inputs.reasoningEffort,
      files: pr.files,
    });
    const confirmed = phase2.findings;
    if (phase2.skipped > 0) {
      core.warning(
        `Verification capped: ${phase2.skipped} lowest-severity candidate findings were not verified and are excluded from the review`,
      );
    }
    core.info(`Phase 2 done: ${confirmed.length} confirmed`);
    for (const d of phase2.discarded) {
      core.info(
        `Discarded by verification: ${d.finding.path}:${d.finding.line} ` +
          `${d.finding.comment} (${d.evidence})`,
      );
    }
    for (const d of phase2.duplicates) {
      core.info(
        `Repeat of an earlier thread: ${d.finding.path}:${d.finding.line} ` +
          `${d.finding.comment} (${d.evidence})`,
      );
    }
    for (const f of phase2.droppedSuggestions) {
      core.info(
        `Suggestion dropped, not confirmed as replacement code: ${f.path}:${f.line} ${f.suggestion}`,
      );
    }
    for (const f of phase2.unverified) {
      core.warning(
        `Verification failed on a re-review, not posted: ${f.path}:${f.line} ${f.comment}`,
      );
    }
    core.info(`Phase 2 tokens: ${describeUsage(phase2.usage)}`);

    const plan = planReview(
      { summary: phase1.output.summary, findings: confirmed },
      pr.files,
      {
        maxInlineComments: inputs.maxInlineComments,
        inlineSeverityThreshold: inputs.inlineSeverityThreshold,
        requestChangesThreshold: inputs.requestChangesThreshold,
        skippedFiles: pr.skippedFiles,
        stats: {
          toolCalls: phase1.toolCalls,
          duplicates: phase2.duplicates.length,
        },
        discarded: phase2.discarded,
        unverified: phase2.unverified.length,
      },
    );
    for (const f of plan.droppedRanges) {
      core.info(
        `Range ${f.startLine}-${f.line} is not fully in the diff, anchored to line ${f.line} only` +
          `${f.suggestion ? " and the suggestion dropped" : ""}: ${f.path}`,
      );
    }

    if (inputs.dryRun) {
      core.info(
        `Dry run, review not posted:\n${JSON.stringify(plan, null, 2)}`,
      );
      return;
    }
    await submitReview(octokit, ref, plan, pr.meta.headSha);
    core.info(
      `Review submitted: ${plan.event}, ${plan.comments.length} inline comments`,
    );
  } catch (err) {
    if (inputs.dryRun) {
      core.error(
        `Dry run: AI review failed, not posting a PR comment. ${err instanceof Error ? err.message : String(err)}`,
      );
    } else {
      await postFailureComment(octokit, ref).catch((e) =>
        core.warning(`Could not post failure comment: ${e}`),
      );
    }
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Entry wrapper: catches errors thrown before run()'s own try block (input
 * validation, missing github_token) so the job fails cleanly via setFailed
 * instead of an unhandled rejection. No PR comment here; that guarantee is
 * scoped to model/API failures inside run(), where a token is known to exist.
 */
export async function main(): Promise<void> {
  try {
    await run();
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

// Entry point when executed as the action bundle; guarded so tests can import safely.
if (process.env.GITHUB_ACTIONS === "true" && process.env.VITEST === undefined) {
  await main();
}
