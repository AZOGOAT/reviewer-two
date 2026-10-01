import * as core from "@actions/core";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  isStepCount,
  type LanguageModel,
  type LanguageModelMiddleware,
  type ModelMessage,
  NoObjectGeneratedError,
  Output,
  tool,
  wrapLanguageModel,
} from "ai";
import { z } from "zod";
import type { ReasoningEffort } from "./schema.js";

export { tool as defineTool };

/** Maps a plain model id string to a provider model instance. */
export function resolveModel(id: string) {
  if (id.startsWith("claude-")) return anthropic(id);
  if (id.startsWith("gpt-") || /^o\d/.test(id)) return openai(id);
  if (id.includes("/")) return openAiCompatibleModel(id);
  throw new Error(
    `Unsupported model "${id}". Use a claude-* id (Anthropic), a gpt-*/o* id ` +
      `(OpenAI), or an org/model id served by an OpenAI-compatible endpoint.`,
  );
}

const CLAUDE_EFFORTS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Rejects a reasoning effort the model's provider is known to refuse, before any call. */
export function checkReasoningEffort(
  modelId: string,
  reasoningEffort: ReasoningEffort | undefined,
): void {
  if (
    reasoningEffort !== undefined &&
    modelId.startsWith("claude-") &&
    !CLAUDE_EFFORTS.includes(reasoningEffort)
  ) {
    throw new Error(
      `Input reasoning_effort "${reasoningEffort}" is not available for Claude models; use one of ${CLAUDE_EFFORTS.join(", ")}`,
    );
  }
}

/**
 * vLLM-style servers enforce response_format as a decoding grammar over the
 * whole completion, where it would block tool calls. Sent only on tool-free
 * requests, it constrains exactly the final review text to the schema.
 */
export const responseFormatOnlyWithoutTools: LanguageModelMiddleware = {
  transformParams: async ({ params }) =>
    params.tools?.length ? { ...params, responseFormat: undefined } : params,
};

const RATE_LIMIT_MAX_WAIT_MS = 60 * 60_000;
const RETRY_AFTER_MIN_S = 5;
const RETRY_AFTER_MAX_S = 10;
const RETRY_AFTER_DEFAULT_S = 10;

/**
 * Wraps fetch so a 429 from the endpoint (another review holding the key's
 * request slot) is waited out and the same request resent. All calls through
 * one wrapper share maxWaitMs of waiting; once it is spent, every 429 goes
 * straight to the SDK, whose own error carries the endpoint's message. A
 * review queued behind another one usually waits for that whole review.
 */
export function waitOnRateLimit(
  fetchImpl: typeof fetch,
  maxWaitMs: number,
): typeof fetch {
  let waited = 0;
  return async (input, init) => {
    for (;;) {
      const res = await fetchImpl(input, init);
      if (res.status !== 429) return res;
      const header = Number.parseFloat(res.headers.get("retry-after") ?? "");
      const seconds = Number.isFinite(header)
        ? Math.min(Math.max(header, RETRY_AFTER_MIN_S), RETRY_AFTER_MAX_S)
        : RETRY_AFTER_DEFAULT_S;
      const ms = seconds * 1_000 + Math.random() * 2_000;
      if (waited + ms > maxWaitMs) return res;
      const said = (await res.text()).slice(0, 300);
      core.info(
        `Model endpoint answered 429, retrying in ${Math.round(ms / 1_000)}s: ${said}`,
      );
      await new Promise((resolve) => setTimeout(resolve, ms));
      waited += ms;
    }
  };
}

// One wrapper per process, so a review's waiting stays within one budget.
const rateLimitedFetch = waitOnRateLimit(
  (input, init) => globalThis.fetch(input, init),
  RATE_LIMIT_MAX_WAIT_MS,
);

/** org/model ids resolve against the endpoint configured via action inputs. */
function openAiCompatibleModel(id: string) {
  const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;
  if (!baseURL) {
    throw new Error(
      `Model "${id}" is served by an OpenAI-compatible endpoint, but none is ` +
        `configured. Set the openai_compatible_base_url input.`,
    );
  }
  const model = createOpenAICompatible({
    name: "openai-compatible",
    baseURL,
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
    supportsStructuredOutputs: true,
    fetch: rateLimitedFetch,
  })(id);
  return wrapLanguageModel({
    model,
    middleware: responseFormatOnlyWithoutTools,
  });
}

interface UsageStep {
  usage: { totalTokens?: number };
}

/**
 * Stop condition on accumulated token usage across steps. A guard against
 * runaway loops, not a depth limiter; undefined budget never stops.
 */
export function exceedsTokenBudget(budget?: number) {
  return ({ steps }: { steps: UsageStep[] }) => {
    if (budget === undefined) return false;
    const used = steps.reduce((n, s) => n + (s.usage.totalTokens ?? 0), 0);
    return used >= budget;
  };
}

// Kept free under the context window for the wrap-up step.
const WRAP_UP_HEADROOM_TOKENS = 50_000;

/**
 * True when the next step must stop exploring and write the review: the step
 * cap, the token budget, or the context window is nearly full (last step's
 * total tokens stand in for context size). Called from prepareStep.
 */
export function shouldWrapUp(opts: {
  stepNumber: number;
  steps: UsageStep[];
  maxToolCalls: number;
  tokenBudget?: number;
  contextWindowTokens: number;
}): boolean {
  if (opts.stepNumber >= opts.maxToolCalls - 1) return true;
  if (exceedsTokenBudget(opts.tokenBudget)({ steps: opts.steps })) return true;
  const last = opts.steps[opts.steps.length - 1];
  return (
    (last?.usage.totalTokens ?? 0) >=
    opts.contextWindowTokens - WRAP_UP_HEADROOM_TOKENS
  );
}

/**
 * Stamps Anthropic cache breakpoints on the first message (the PR context)
 * and the last two messages, clearing markers left at earlier positions.
 * With the system breakpoint that is four total, Anthropic's limit; the
 * moving pair keeps each step's prefix a cache hit as the history grows.
 */
export function placeCacheBreakpoints(
  messages: ModelMessage[],
): ModelMessage[] {
  const last = messages.length - 1;
  return messages.map((message, i) => {
    const marked = i === 0 || i >= last - 1;
    if (!marked && message.providerOptions?.anthropic === undefined) {
      return message;
    }
    const providerOptions = { ...message.providerOptions };
    const anthropic = {
      ...(providerOptions.anthropic as Record<string, unknown> | undefined),
    };
    if (marked) anthropic.cacheControl = { type: "ephemeral" };
    else delete anthropic.cacheControl;
    if (Object.keys(anthropic).length > 0) {
      providerOptions.anthropic = anthropic as never;
    } else {
      delete providerOptions.anthropic;
    }
    if (Object.keys(providerOptions).length === 0) {
      const { providerOptions: _dropped, ...rest } = message;
      return rest as ModelMessage;
    }
    return { ...message, providerOptions };
  });
}

/**
 * Fails a run that ended without a review, naming the finish reason and token
 * usage. The SDK on its own surfaces only a bare "No output generated.".
 */
export function assertFinished(result: {
  finishReason: string;
  steps: unknown[];
  totalUsage: { totalTokens?: number };
}): void {
  if (result.finishReason === "stop") return;
  throw new Error(
    `The model stopped without producing the review output ` +
      `(finish reason "${result.finishReason}", ${result.steps.length} steps, ` +
      `${result.totalUsage.totalTokens ?? "unknown"} total tokens).`,
  );
}

/** Token counts by price class, for spotting broken caching in run logs. */
export interface UsageBreakdown {
  noCache: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

interface TotalUsage {
  inputTokenDetails: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokens?: number;
}

function toUsageBreakdown(totalUsage: TotalUsage): UsageBreakdown {
  const input = totalUsage.inputTokenDetails;
  return {
    noCache: input.noCacheTokens ?? 0,
    cacheRead: input.cacheReadTokens ?? 0,
    cacheWrite: input.cacheWriteTokens ?? 0,
    output: totalUsage.outputTokens ?? 0,
  };
}

/** Sums two usage breakdowns field by field. */
export function addUsage(a: UsageBreakdown, b: UsageBreakdown): UsageBreakdown {
  return {
    noCache: a.noCache + b.noCache,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}

// Hiding the tools is not enough: a model deep in an exploration loop keeps
// calling them by name from memory, so the wrap-up must be said out loud.
const WRAP_UP_DEMAND =
  "Tool access is closed and no more tool calls will be answered. " +
  "Write the final review output now, in the required format, " +
  "using only what you have already gathered.";

/** Appends the wrap-up demand unless an earlier step already added it. */
function withWrapUpDemand(messages: ModelMessage[]): ModelMessage[] {
  const has = messages.some(
    (m) => m.role === "user" && m.content === WRAP_UP_DEMAND,
  );
  return has
    ? messages
    : [...messages, { role: "user", content: WRAP_UP_DEMAND }];
}

/**
 * Demand sent when the model's review failed schema validation, quoting the
 * validation detail so the rewrite fixes the actual problem.
 */
function schemaRepairDemand(error: NoObjectGeneratedError): string {
  const detail =
    error.cause instanceof Error ? error.cause.message.slice(0, 2_000) : "";
  return (
    "That output failed validation against the required schema. " +
    (detail ? `Validation errors: ${detail}\n` : "") +
    "Write the complete review output again, in the required format, " +
    "fixing only what the schema requires."
  );
}

/** Drops trailing assistant tool calls that never got results; the API rejects them. */
function dropDanglingToolCalls(messages: ModelMessage[]): ModelMessage[] {
  const out = [...messages];
  while (out.length > 0) {
    const last = out[out.length - 1];
    const parts = Array.isArray(last?.content) ? last.content : [];
    const dangling =
      last?.role === "assistant" &&
      parts.some((p) => typeof p === "object" && p?.type === "tool-call");
    if (!dangling) break;
    out.pop();
  }
  return out;
}

/**
 * The output schema as prompt text, for endpoints that enforce the schema
 * only as a server-side grammar the model never gets to read.
 */
export function schemaAsPromptText(schema: z.ZodType): string {
  return (
    "When you write the final output, reply with a single JSON object " +
    "matching this JSON schema, with no code fences and no text before or " +
    "after it:\n" +
    JSON.stringify(z.toJSONSchema(schema))
  );
}

/** The user prompt as messages, one per part; a shared first part stays a cacheable prefix. */
function promptMessages(prompt: string | string[]): ModelMessage[] {
  const parts = typeof prompt === "string" ? [prompt] : prompt;
  return parts.map((content) => ({ role: "user", content }) as ModelMessage);
}

export interface AgenticCallOptions<T> {
  modelId: string | LanguageModel;
  system: string;
  prompt: string | string[];
  schema: z.ZodType<T>;
  tools?: Parameters<typeof generateText>[0]["tools"];
  maxToolCalls: number;
  tokenBudget?: number;
  contextWindowTokens: number;
  reasoningEffort: ReasoningEffort | undefined;
}

/**
 * Provider options for every call. Each provider reads only its own key, so a
 * reasoning effort is set for all three. Claude takes it as effort rather than
 * extended thinking, which cannot run next to the forced json tool call; OpenAI
 * gets no reasoning summary, which the SDK would otherwise request with it.
 */
export function callProviderOptions(
  reasoningEffort: ReasoningEffort | undefined,
): Record<string, Record<string, string | null>> {
  if (reasoningEffort === undefined) {
    return { anthropic: { structuredOutputMode: "jsonTool" } };
  }
  return {
    anthropic: { structuredOutputMode: "jsonTool", effort: reasoningEffort },
    openai: { reasoningEffort, reasoningSummary: null },
    openaiCompatible: { reasoningEffort },
  };
}

/**
 * One agentic call with structured output. Used by phase 1 (with generous
 * budgets) and phase 2 (with small ones). The system message and, per step,
 * the prompt and latest messages carry Anthropic cache breakpoints; OpenAI
 * models ignore that provider option. A run that still ends without output
 * gets one tool-free recovery call before failing, so the spend is not lost.
 */
export async function runStructured<T>(
  opts: AgenticCallOptions<T>,
): Promise<{ output: T; toolCalls: number; usage: UsageBreakdown }> {
  const maxToolCalls = opts.maxToolCalls;
  const model =
    typeof opts.modelId === "string"
      ? resolveModel(opts.modelId)
      : opts.modelId;
  const providerOptions = callProviderOptions(opts.reasoningEffort);
  const system =
    typeof opts.modelId === "string" && opts.modelId.includes("/")
      ? `${opts.system}\n\n${schemaAsPromptText(opts.schema)}`
      : opts.system;
  const instructions = {
    role: "system",
    content: system,
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  } as const;

  // Accumulated per step so the counts survive when generateText throws
  // after the loop, as it does on a schema-invalid final output.
  let toolCalls = 0;
  let usage: UsageBreakdown = {
    noCache: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  };
  const trackStep = (step: { toolCalls: unknown[]; usage: TotalUsage }) => {
    toolCalls += step.toolCalls.length;
    usage = addUsage(usage, toUsageBreakdown(step.usage));
  };

  let wrapUpStep: number | undefined;
  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
      model,
      providerOptions,
      instructions,
      messages: promptMessages(opts.prompt),
      tools: opts.tools,
      // Each step re-stamps cache breakpoints. When a limit is hit the step
      // hides the exploration tools and demands the review in a user message;
      // the second stop condition ends the loop right after that step in case
      // the model ignores the demand and keeps emitting tool calls.
      prepareStep: ({ stepNumber, steps, messages }) => {
        const wrapUp = shouldWrapUp({
          stepNumber,
          steps,
          maxToolCalls,
          tokenBudget: opts.tokenBudget,
          contextWindowTokens: opts.contextWindowTokens,
        });
        if (wrapUp) wrapUpStep ??= stepNumber;
        return {
          messages: placeCacheBreakpoints(
            wrapUp ? withWrapUpDemand(messages) : messages,
          ),
          ...(wrapUp ? { activeTools: [] } : {}),
        };
      },
      stopWhen: [
        isStepCount(maxToolCalls + 1),
        ({ steps }) => wrapUpStep !== undefined && steps.length > wrapUpStep,
      ],
      output: Output.object({ schema: opts.schema }),
      onStepFinish: trackStep,
    });
  } catch (error) {
    // The model wrote a review but its JSON failed the schema: send the
    // invalid text back with the validation errors and demand a rewrite.
    if (!NoObjectGeneratedError.isInstance(error) || error.text === undefined) {
      throw error;
    }
    try {
      const repaired = await generateText({
        model,
        providerOptions,
        instructions,
        messages: placeCacheBreakpoints([
          ...promptMessages(opts.prompt),
          { role: "assistant", content: error.text },
          { role: "user", content: schemaRepairDemand(error) },
        ]),
        output: Output.object({ schema: opts.schema }),
        onStepFinish: trackStep,
      });
      return {
        output: opts.schema.parse(repaired.output),
        toolCalls,
        usage,
      };
    } catch {
      throw error;
    }
  }

  if (result.finishReason !== "stop") {
    try {
      const recovery = await generateText({
        model,
        providerOptions,
        instructions,
        messages: placeCacheBreakpoints([
          ...promptMessages(opts.prompt),
          ...dropDanglingToolCalls(result.responseMessages as ModelMessage[]),
          { role: "user", content: WRAP_UP_DEMAND },
        ]),
        output: Output.object({ schema: opts.schema }),
        onStepFinish: trackStep,
      });
      if (recovery.finishReason === "stop") {
        return {
          output: opts.schema.parse(recovery.output),
          toolCalls,
          usage,
        };
      }
    } catch {
      // fall through to the diagnostic error below
    }
    assertFinished(result);
  }
  return {
    output: opts.schema.parse(result.output),
    toolCalls,
    usage,
  };
}
