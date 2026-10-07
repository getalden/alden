import { z } from "zod";

/**
 * A PR's diff (or the local changes a briefing covers) as the UI's Diff tab shows it: `GET /api/diff`. Every string in
 * it was written by the PR's author, so the server strips control sequences before sending it.
 */
export const DiffLineSchema = z.object({
  kind: z.enum(["add", "del", "ctx"]).describe("added, deleted, or unchanged context"),
  oldLine: z.number().int().positive().optional().describe("the line in the old file (deleted and context lines)"),
  newLine: z.number().int().positive().optional().describe("the line in the new file (added and context lines)"),
  text: z.string().describe("the line without its +, - or space marker"),
});

export const DiffHunkSchema = z.object({
  header: z.string().describe('the hunk header, e.g. "@@ -49,7 +49,7 @@ def sign(…)"'),
  lines: z.array(DiffLineSchema),
});

export const DiffFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional().describe("the old path, for renames"),
  status: z.enum(["added", "modified", "removed", "renamed"]),
  additions: z.number().int().min(0).optional(),
  deletions: z.number().int().min(0).optional(),
  binary: z.boolean().optional().describe("a binary file: it changed, but there are no lines to show"),
  patchMissing: z
    .boolean()
    .optional()
    .describe("the file changed but its diff was too large for GitHub to send; `hunks` is empty"),
  hunks: z.array(DiffHunkSchema),
});

export const PrDiffSchema = z.object({
  headSha: z
    .string()
    .describe("the PR head commit the diff is of; for local changes, HEAD's commit (the working tree differs from it)"),
  files: z.array(DiffFileSchema),
});

export type DiffLineKind = z.infer<typeof DiffLineSchema>["kind"];
export type PrDiffLine = z.infer<typeof DiffLineSchema>;
export type PrDiffHunk = z.infer<typeof DiffHunkSchema>;
export type PrDiffFile = z.infer<typeof DiffFileSchema>;
export type PrDiff = z.infer<typeof PrDiffSchema>;
