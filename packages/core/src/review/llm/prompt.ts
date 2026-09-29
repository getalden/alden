import type { BriefingTarget, CheckResult } from "@alden/schema";
import { z } from "zod";
import type { DiffFile } from "../../diff/parse.js";
import { fileKind, isLockfile } from "../../queue/files.js";

/** What the model is asked to return. Alden validates locations before trusting any of it. */
export const LlmOutputSchema = z.object({
  summary: z.string().describe("What the change does, in two or three plain sentences for a busy reviewer."),
  matchesTitle: z.object({
    verdict: z.enum(["yes", "partly", "no", "unclear"]),
    reason: z.string().describe("One sentence."),
  }),
  findings: z
    .array(
      z.object({
        title: z.string().describe("A short label, under 70 characters."),
        detail: z.string().describe("What's wrong or worth checking, and why, in one or two sentences."),
        severity: z.enum(["low", "medium", "high"]),
        anchors: z
          .array(z.object({ path: z.string(), line: z.number().int().optional() }))
          .describe("Where it is: file paths from the diff, with new-file line numbers as shown in the diff."),
      }),
    )
    .describe("Everything a reviewer should know about, including low-confidence concerns."),
});

export type LlmOutput = z.infer<typeof LlmOutputSchema>;

/**
 * Stable across reviews so it can be cached. Written for Claude Sonnet 5, which follows instructions literally: it
 * asks for everything worth a look, because Alden ranks and filters downstream.
 */
export const SYSTEM_PROMPT = `You help a software engineer review a code change. They will read your notes before, or instead of, the whole diff, so their attention is the scarce resource.

You receive the change's title and description, deterministic check results that Alden already computed, and the diff. Diff lines are prefixed with their line number in the new file; deleted lines have no number.

Report every issue a careful reviewer would want to know about: bugs, behaviour changes, missing edge cases, risky operations, security concerns, and anything that doesn't match what the title and description claim. Include concerns you are unsure about, marked low severity; Alden ranks and filters them, so do not hold back to keep the list short. Do not repeat a check result unless you add something it missed. In particular, never report that CI is failing or pending: Alden already shows that and the author has to act on it. If the diff reveals a likely cause of a CI failure, report the cause itself. When the same change repeats across many files, report it once with every location in its anchors.

Anchor each finding to file paths from the diff and to new-file line numbers exactly as shown. Omit the line for a whole-file concern. Never invent a path or line.

Judge whether the change does what its title and description say: "yes", "partly", "no", or "unclear" when there is no meaningful description. Write plainly, with no preamble and no praise.`;

/** Rough token cost of text: about 3 characters per token for code. Real counts come from the provider. */
const tokens = (text: string) => Math.ceil(text.length / 3);

/** A file's diff with new-file line numbers, as the model sees it. */
export function renderFileDiff(file: DiffFile): string {
  const header = `### ${file.previousPath ? `${file.previousPath} → ` : ""}${file.path} (${file.status}, +${file.additions}/-${file.deletions})`;
  if (file.binary) return `${header}\n(binary file)`;
  if (file.patchMissing) return `${header}\n(diff too large to fetch)`;
  const body = file.hunks.flatMap((hunk) => [
    hunk.header,
    ...hunk.lines.map((line) => {
      const number = line.newLine === undefined ? "" : String(line.newLine);
      const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      return `${number.padStart(5)} ${marker} ${line.text}`;
    }),
  ]);
  return [header, ...body].join("\n");
}

/** Files most worth the model's attention first: flagged by a check, then code, config, tests, docs. Lockfiles never go in. */
function priority(file: DiffFile, flaggedPaths: Set<string>): number {
  if (flaggedPaths.has(file.path)) return 0;
  const kind = fileKind(file.path);
  if (kind === "code") return 1;
  if (kind === "other" || kind === "dependency") return 2;
  if (kind === "test") return 3;
  return 4;
}

function describeChecks(checks: CheckResult[]): string {
  return checks
    .map((c) => {
      const evidence = c.status === "flagged" ? c.evidence.map((e) => `\n    - ${e.text}`).join("") : "";
      return `- [${c.status}${c.status === "flagged" ? `, ${c.severity}` : ""}] ${c.title}: ${c.summary}${evidence}`;
    })
    .join("\n");
}

export interface BuiltPrompt {
  system: string;
  user: string;
  includedFiles: string[];
  omittedFiles: string[];
}

export interface PromptInput {
  target: BriefingTarget;
  description?: string;
  files: DiffFile[];
  checks: CheckResult[];
  /** Input-token allowance for the whole request (system + user), e.g. from the budget. */
  maxInputTokens: number;
}

/**
 * The review request. Files are added in priority order until the allowance runs out; the rest are named as omitted
 * so the model (and the briefing) can say what went unseen.
 */
export function buildPrompt(input: PromptInput): BuiltPrompt {
  const { target, checks } = input;
  const heading =
    target.kind === "pr"
      ? `# ${target.repo}#${target.number}: ${target.title}\nBy @${target.author ?? "ghost"}, ${target.headRef} → ${target.baseRef}`
      : `# Local changes${target.branch ? ` on ${target.branch}` : ""}, not yet committed`;
  const description = input.description?.trim() ? input.description.trim().slice(0, 6000) : "(no description)";
  const preamble = `${heading}\n\n## Description\n${description}\n\n## Alden's checks\n${describeChecks(checks)}\n\n## Diff`;

  const flagged = new Set(
    checks
      .filter((c) => c.status === "flagged")
      .flatMap((c) => c.evidence.flatMap((e) => (e.anchor ? [e.anchor.path] : []))),
  );
  const candidates = input.files
    .filter((f) => !isLockfile(f.path))
    .map((file, index) => ({ file, index, rank: priority(file, flagged) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);

  let used = tokens(SYSTEM_PROMPT) + tokens(preamble) + 200; // 200 for the omitted-files note
  const included: DiffFile[] = [];
  // Lockfiles are skipped on purpose (the dependency check reads them), so they aren't "omitted for budget".
  const omitted: string[] = [];
  for (const { file } of candidates) {
    const cost = tokens(renderFileDiff(file)) + 1;
    if (used + cost <= input.maxInputTokens) {
      included.push(file);
      used += cost;
    } else {
      omitted.push(file.path);
    }
  }

  // Show included files in their original order, which usually groups related changes.
  const inOrder = input.files.filter((f) => included.includes(f));
  const omittedNote =
    omitted.length > 0
      ? `\n\n## Not shown (over budget)\n${omitted.map((p) => `- ${p}`).join("\n")}\nDon't make findings about these files.`
      : "";
  return {
    system: SYSTEM_PROMPT,
    user: `${preamble}\n\n${inOrder.map(renderFileDiff).join("\n\n")}${omittedNote}`,
    includedFiles: inOrder.map((f) => f.path),
    omittedFiles: omitted,
  };
}
