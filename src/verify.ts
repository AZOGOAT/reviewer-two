import * as core from "@actions/core";
import {
  type FileDiff,
  type PreviousThread,
  patchLineText,
} from "./context.js";
import type { makeExploreTools } from "./explore.js";
import { addUsage, runStructured, type UsageBreakdown } from "./model.js";
import { buildVerifyPreamble, buildVerifyPrompt } from "./prompts.js";
import { threadStatus } from "./review.js";
import {
  type Finding,
  type ReasoningEffort,
  type Severity,
  severities,
  verificationSchema,
} from "./schema.js";

const VERIFY_TOOL_CALLS = 10;
const MAX_VERIFIED_FINDINGS = 20;

/** The error message followed by its chain of causes, which carry the network or parse detail. */
function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current !== undefined && parts.length < 4) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" <- caused by: ");
}

/**
 * Phase 2: re-examines each candidate finding with fresh tool access and keeps
 * the ones the model confirms. Verifies at most MAX_VERIFIED_FINDINGS, most
 * severe first, candidates on the line of a closed earlier thread last; the
 * overflow is counted in skipped. On a re-review a duplicate verdict lands in
 * duplicates and a failed call in unverified; on a first review they discard
 * and confirm respectively. A suggestion block survives only on a keep ruling;
 * the finding keeps its comment either way.
 */
export async function verifyFindings(opts: {
  modelId: string;
  system: string;
  findings: Finding[];
  previous: PreviousThread[];
  requestChangesThreshold: Severity;
  tools: ReturnType<typeof makeExploreTools>;
  contextWindowTokens: number;
  reasoningEffort: ReasoningEffort | undefined;
  files: FileDiff[];
}): Promise<{
  findings: Finding[];
  discarded: { finding: Finding; evidence: string }[];
  duplicates: { finding: Finding; evidence: string }[];
  unverified: Finding[];
  droppedSuggestions: Finding[];
  usage: UsageBreakdown;
  skipped: number;
}> {
  const confirmed: Finding[] = [];
  const discarded: { finding: Finding; evidence: string }[] = [];
  const duplicates: { finding: Finding; evidence: string }[] = [];
  const unverified: Finding[] = [];
  const droppedSuggestions: Finding[] = [];
  let usage: UsageBreakdown = {
    noCache: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  };
  const reReview = opts.previous.length > 0;
  const confirm = (
    finding: Finding,
    output: { severity?: Severity; suggestion: "keep" | "drop" | "none" },
  ): void => {
    const keeps = output.suggestion === "keep";
    if (finding.suggestion && !keeps) droppedSuggestions.push(finding);
    confirmed.push({
      ...finding,
      severity: output.severity ?? finding.severity,
      suggestion: keeps ? finding.suggestion : undefined,
    });
  };
  const preamble = buildVerifyPreamble(
    opts.previous,
    opts.requestChangesThreshold,
  );
  const patches = new Map(opts.files.map((f) => [f.path, f.patch]));
  const closedLines = new Set(
    opts.previous
      .filter(
        (t) =>
          t.line !== null &&
          threadStatus(t, opts.requestChangesThreshold) === "closed",
      )
      .map((t) => `${t.path}:${t.line}`),
  );
  const likelyRepeat = (f: Finding): number =>
    closedLines.has(`${f.path}:${f.line}`) ? 1 : 0;
  for (const f of opts.findings) {
    if (likelyRepeat(f)) {
      core.info(
        `Same line as a closed earlier thread, verified last: ${f.path}:${f.line}`,
      );
    }
  }
  const selected = [...opts.findings]
    .sort(
      (a, b) =>
        likelyRepeat(a) - likelyRepeat(b) ||
        severities.indexOf(a.severity) - severities.indexOf(b.severity),
    )
    .slice(0, MAX_VERIFIED_FINDINGS);
  for (const finding of selected) {
    const patch = patches.get(finding.path);
    const flaggedText =
      patch === undefined
        ? null
        : patchLineText(patch, finding.startLine ?? finding.line, finding.line);
    try {
      const { output, usage: callUsage } = await runStructured({
        modelId: opts.modelId,
        system: opts.system,
        prompt: [preamble, buildVerifyPrompt(finding, flaggedText)],
        schema: verificationSchema,
        tools: opts.tools,
        maxToolCalls: VERIFY_TOOL_CALLS,
        contextWindowTokens: opts.contextWindowTokens,
        reasoningEffort: opts.reasoningEffort,
      });
      usage = addUsage(usage, callUsage);
      if (output.verdict === "confirmed") {
        confirm(finding, output);
      } else if (output.verdict === "duplicate" && reReview) {
        duplicates.push({ finding, evidence: output.evidence });
      } else {
        discarded.push({ finding, evidence: output.evidence });
      }
    } catch (err) {
      core.warning(
        `Verification call failed for ${finding.path}:${finding.line}: ${describeError(err)}`,
      );
      if (reReview) unverified.push(finding);
      else confirm(finding, { suggestion: "drop" });
    }
  }
  return {
    findings: confirmed,
    discarded,
    duplicates,
    unverified,
    droppedSuggestions,
    usage,
    skipped: opts.findings.length - selected.length,
  };
}
