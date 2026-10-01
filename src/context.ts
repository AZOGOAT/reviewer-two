import * as core from "@actions/core";
import type { getOctokit } from "@actions/github";
import picomatch from "picomatch";
import { parseFindingTrailer } from "./review.js";

export type Octokit = ReturnType<typeof getOctokit>;

export interface FileDiff {
  path: string;
  patch: string;
  commentableLines: Set<number>;
}

export interface PrMeta {
  title: string;
  body: string;
  author: string;
  baseRef: string;
  headSha: string;
}

export interface PrContext {
  meta: PrMeta;
  files: FileDiff[];
  skippedFiles: string[];
  changedPaths: string[];
}

/**
 * One inline comment the reviewer posted in an earlier round, with the human
 * replies under it. line is the position in the current head, null once the
 * anchored code changed; originalLine is where it was posted. resolved is the
 * conversation state on GitHub.
 */
export interface PreviousThread {
  path: string;
  line: number | null;
  originalLine: number | null;
  body: string;
  resolved: boolean;
  replies: { author: string; body: string }[];
}

export interface PrRef {
  owner: string;
  repo: string;
  pullNumber: number;
}

const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/*.egg-info/**",
  "**/_generated/**",
  "**/dist/**",
  "**/out/**",
  "**/poetry.lock",
  "**/uv.lock",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
];

// "**/" matches zero directories, so root-level lockfiles match too
const excludeMatcher = picomatch(DEFAULT_EXCLUDES, {
  dot: true,
  basename: false,
});

/** True for lockfiles and generated paths that must never enter review content. */
export function isExcluded(path: string): boolean {
  return excludeMatcher(path);
}

/**
 * Parses a unified diff into per-file patches. commentableLines holds the
 * new-side line numbers present in hunks; GitHub inline comments only anchor there.
 */
export function parseDiff(diff: string): FileDiff[] {
  const files: { path: string; patch: string }[] = [];
  let current: { path: string; patch: string } | null = null;
  // a "+++ " header is only expected before the first "@@" of a file; once
  // inside a hunk body, a line that happens to start with "+++ " is content
  // (e.g. an added line of "++ x"), not a phantom next file.
  let inHunk = false;
  const lines = diff.split("\n");
  // a trailing newline yields one empty tail element; it is not a diff line
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      current = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ") && !inHunk) {
      const raw = line.slice(4).trim();
      if (raw === "/dev/null") {
        current = null;
      } else {
        current = { path: raw.replace(/^b\//, ""), patch: "" };
        files.push(current);
      }
      continue;
    }
    if (!current) continue;
    current.patch += `${line}\n`;
    if (line.startsWith("@@")) inHunk = true;
  }
  return files.map((f) => ({
    ...f,
    commentableLines: commentableLinesFromPatch(f.patch),
  }));
}

/**
 * New-side lines of one file's standalone hunk patch (no file headers), keyed
 * by line number. These are the lines GitHub can anchor an inline comment to.
 */
export function newSideLines(patch: string): Map<number, string> {
  const lines = new Map<number, string>();
  let newLine = 0;
  for (const line of patch.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("@@")) {
      const m = /\+(\d+)/.exec(line);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (line.startsWith("+") || line.startsWith(" ") || line === "") {
      if (newLine > 0) lines.set(newLine, line.slice(1));
      newLine++;
    }
  }
  return lines;
}

/** New-side commentable line numbers of one file's hunk patch. */
function commentableLinesFromPatch(patch: string): Set<number> {
  return new Set(newSideLines(patch).keys());
}

/**
 * New-side text of lines start..end from one file's hunk patch. Returns null
 * unless the range is well formed and every line of it is present in the
 * patch, so callers can show the exact code a finding flags.
 */
export function patchLineText(
  patch: string,
  start: number,
  end: number,
): string | null {
  if (start > end) return null;
  const text = newSideLines(patch);
  const lines: string[] = [];
  for (let n = start; n <= end; n++) {
    const t = text.get(n);
    if (t === undefined) return null;
    lines.push(t);
  }
  return lines.join("\n");
}

/**
 * Builds FileDiff entries from the listFiles response instead of the whole
 * diff. Used when the whole-diff request is rejected for size (HTTP 406).
 * Files without a patch (binary, too large for GitHub to include) are
 * skipped here; the caller reports them in skippedFiles.
 */
function filesFromListFiles(
  prFiles: { filename: string; patch?: string }[],
): FileDiff[] {
  return prFiles
    .filter((f): f is { filename: string; patch: string } => !!f.patch)
    .map((f) => ({
      path: f.filename,
      patch: f.patch,
      commentableLines: commentableLinesFromPatch(f.patch),
    }));
}

// Code runs about 4 chars per token, so the diff stays near a third of the window.
const DIFF_CHARS_PER_WINDOW_TOKEN = 1.5;

/** Character cap on the diff placed in the prompt, scaled to the model's context window. */
export function diffCharBudget(contextWindowTokens: number): number {
  return Math.floor(contextWindowTokens * DIFF_CHARS_PER_WINDOW_TOKEN);
}

/**
 * Keeps the total patch size under maxChars by dropping the largest file
 * patches first. Dropped paths are reported, never silently lost.
 */
export function degradeIfOversized(
  files: FileDiff[],
  maxChars: number,
): { files: FileDiff[]; skipped: string[] } {
  let total = files.reduce((n, f) => n + f.patch.length, 0);
  if (total <= maxChars) return { files, skipped: [] };
  const bySize = [...files].sort((a, b) => b.patch.length - a.patch.length);
  const skippedSet = new Set<string>();
  for (const f of bySize) {
    if (total <= maxChars) break;
    skippedSet.add(f.path);
    total -= f.patch.length;
  }
  return {
    files: files.filter((f) => !skippedSet.has(f.path)),
    skipped: [...skippedSet],
  };
}

/** Fetches PR metadata and diff, applying excludes and the diff budget. */
export async function gatherPr(
  octokit: Octokit,
  ref: PrRef,
  maxDiffChars: number,
): Promise<PrContext> {
  const { owner, repo, pullNumber } = ref;
  const pr = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  const prFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  let allFiles: FileDiff[];
  try {
    const diffResponse = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo,
        pull_number: pullNumber,
        mediaType: { format: "diff" },
      },
    );
    allFiles = parseDiff(diffResponse.data as unknown as string);
  } catch (err) {
    if ((err as { status?: number }).status !== 406) throw err;
    // PR too large for GitHub to render as one diff; per-file patches still work.
    allFiles = filesFromListFiles(prFiles);
  }
  // patchless files (binary, too large) are reported
  const present = new Set(allFiles.map((f) => f.path));
  const omitted = prFiles
    .filter(
      (f) => !f.patch && !present.has(f.filename) && !isExcluded(f.filename),
    )
    .map((f) => f.filename);
  const reviewable = allFiles.filter((f) => !isExcluded(f.path));
  const { files, skipped } = degradeIfOversized(reviewable, maxDiffChars);
  return {
    meta: {
      title: pr.data.title,
      body: pr.data.body ?? "",
      author: pr.data.user?.login ?? "unknown",
      baseRef: pr.data.base.ref,
      headSha: pr.data.head.sha,
    },
    files,
    skippedFiles: [...skipped, ...omitted],
    changedPaths: prFiles.map((f) => f.filename),
  };
}

interface ReviewThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          isResolved: boolean;
          comments: { nodes: { databaseId: number | null }[] };
        }[];
      };
    };
  };
}

const RESOLVED_THREADS_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved
            comments(first: 1) { nodes { databaseId } }
          }
        }
      }
    }
  }`;

/** Ids of the root comments whose conversation is resolved. Empty when the query is unavailable. */
async function fetchResolvedRootIds(
  octokit: Octokit,
  ref: PrRef,
): Promise<Set<number>> {
  const resolved = new Set<number>();
  let cursor: string | null = null;
  try {
    for (;;) {
      const page: ReviewThreadsPage = await octokit.graphql(
        RESOLVED_THREADS_QUERY,
        {
          owner: ref.owner,
          repo: ref.repo,
          number: ref.pullNumber,
          cursor,
        },
      );
      const { nodes, pageInfo } = page.repository.pullRequest.reviewThreads;
      for (const node of nodes) {
        const rootId = node.comments.nodes[0]?.databaseId;
        if (node.isResolved && rootId) resolved.add(rootId);
      }
      if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
      cursor = pageInfo.endCursor;
    }
  } catch (err) {
    core.warning(
      `Could not read resolved conversations, treating every thread as unresolved: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Set();
  }
  return resolved;
}

/**
 * Fetches the reviewer's own earlier inline comments as threads, with the
 * human replies under each and the conversation's resolved state. Roots are
 * the ones carrying the finding trailer.
 */
export async function fetchPreviousThreads(
  octokit: Octokit,
  ref: PrRef,
  botLogins: string[],
): Promise<PreviousThread[]> {
  const [comments, resolvedRoots] = await Promise.all([
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.pullNumber,
      per_page: 100,
    }),
    fetchResolvedRootIds(octokit, ref),
  ]);
  const logins = new Set(botLogins);
  const isSelf = (c: { user: { login: string } | null }) =>
    c.user !== null && logins.has(c.user.login);
  const isHuman = (c: { user: { login: string; type: string } | null }) =>
    !isSelf(c) && c.user?.type !== "Bot";
  const roots = new Map<number, PreviousThread>();
  for (const c of comments) {
    if (c.in_reply_to_id || !isSelf(c) || !parseFindingTrailer(c.body))
      continue;
    roots.set(c.id, {
      path: c.path,
      line: c.line ?? null,
      originalLine: c.original_line ?? null,
      body: c.body,
      resolved: resolvedRoots.has(c.id),
      replies: [],
    });
  }
  for (const c of comments) {
    if (!c.in_reply_to_id || !isHuman(c)) continue;
    roots.get(c.in_reply_to_id)?.replies.push({
      author: c.user?.login ?? "unknown",
      body: c.body,
    });
  }
  return [...roots.values()];
}
