import { z } from "zod";

export const severities = ["critical", "major", "minor", "nit"] as const;
export type Severity = (typeof severities)[number];

export const reasoningEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

/** One reviewer finding, anchored to a file and line in the PR head. */
export const findingSchema = z.object({
  path: z.string().min(1).describe("Repository-relative path of the file"),
  line: z
    .number()
    .int()
    .positive()
    .describe(
      "Line number in the new version of the file; for a multi-line finding, the last line of the flagged range",
    ),
  startLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "First line of the flagged range when it spans more than one line; must be above line and inside the diff. Omit for a single-line finding",
    ),
  severity: z.enum(severities),
  comment: z
    .string()
    .min(1)
    .describe("Short, direct comment stating the problem and its consequence"),
  suggestion: z
    .string()
    .optional()
    .describe(
      "Code that replaces the flagged range exactly (startLine through line, or the single line), committed verbatim when the author applies it",
    ),
  ruleRef: z
    .string()
    .min(1)
    .describe("Rule file or section violated, or 'general'"),
});
export type Finding = z.infer<typeof findingSchema>;

/** Structured output contract of the review phases. */
export const reviewOutputSchema = z.object({
  summary: z
    .string()
    .describe(
      "One or two sentence verdict; never describe the change itself, never count the findings or name their severities, never mention earlier rounds",
    ),
  findings: z.array(findingSchema),
});
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

/** Phase-2 verdict on a single candidate finding. evidence comes first so the
 * model states it before ruling; fields are emitted in schema order. */
export const verificationSchema = z.object({
  // Write-only on purpose: demanding stated evidence makes the verdict more reliable.
  evidence: z
    .string()
    .describe("Concrete code evidence, or the reason for discarding"),
  verdict: z
    .enum(["confirmed", "discarded", "duplicate"])
    .describe(
      "duplicate: restates the numbered thread named in duplicateOf and that thread is marked [closed]; a match with an [open] thread is confirmed or discarded like any other finding",
    ),
  duplicateOf: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Number of the earlier thread the finding restates, as shown in its header; required with the duplicate verdict",
    ),
  severity: z
    .enum(severities)
    .optional()
    .describe(
      "Corrected severity when the evidence shows the impact differs from what was stated",
    ),
  suggestion: z
    .enum(["keep", "drop", "none"])
    .describe(
      "Ruling on the finding's suggestion block: keep when it is replacement code for the flagged lines, drop when it is not, none when the finding carries no block",
    ),
});
