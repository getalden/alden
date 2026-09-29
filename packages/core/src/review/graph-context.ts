import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DiffFile } from "../diff/parse.js";
import { changedNewLines, changedSymbols, loadChangeSymbols } from "../graph/changes.js";
import { indexRepo } from "../graph/index-repo.js";
import { languageOf } from "../graph/parser.js";
import { CodeGraph } from "../graph/query.js";
import { createResolver, loadResolverConfig } from "../graph/resolve.js";
import { fileKind } from "../queue/files.js";
import { type GraphContext, symbolKey } from "./types.js";

const run = promisify(execFile);

/** Callers shown per symbol, and lines of code shown around each for the model. */
const SNIPPETS_PER_SYMBOL = 4;
const SNIPPET_RADIUS = 2;

export interface GraphReview {
  context: GraphContext;
  /** Call sites with a few lines of code around each, for the model's prompt. */
  callerSnippets: string;
}

/**
 * The code graph's view of a change: which public symbols it touches and who calls them outside the diff. `root` is a
 * checkout of the new code (the working tree, or a PR worktree). Production callers come before tests.
 */
export async function buildGraphReview(root: string, files: DiffFile[], budgetMs = 60_000): Promise<GraphReview> {
  const index = await indexRepo(root, { budgetMs });
  const { stdout } = await run("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  const tracked = stdout.split("\0").filter(Boolean);
  const graph = new CodeGraph(index.files, createResolver(index.files.keys(), await loadResolverConfig(root, tracked)));

  const read = async (path: string) => {
    try {
      return await readFile(join(root, path), "utf8");
    } catch {
      return undefined;
    }
  };
  const { after, before } = await loadChangeSymbols(files, read);
  const changes = changedSymbols(files, after, before);
  const exclude = new Map(files.map((f) => [f.path, changedNewLines(f)]));

  const callers = new Map<string, ReturnType<CodeGraph["callersOf"]>>();
  for (const change of changes) {
    if (!change.exported || change.change === "added") continue;
    const sites = graph.callersOf(change, exclude);
    // Production code first: that's where a break hurts; tests follow.
    sites.sort((a, b) => Number(fileKind(a.path) === "test") - Number(fileKind(b.path) === "test"));
    callers.set(symbolKey(change), sites);
  }

  const snippets: string[] = [];
  const sources = new Map<string, string[]>();
  for (const change of changes) {
    const sites = callers.get(symbolKey(change)) ?? [];
    if (sites.length === 0) continue;
    const label = `${change.container ? `${change.container}.` : ""}${change.name}`;
    snippets.push(
      `### ${label} (${change.path}, ${change.change}) is used in ${sites.length} place${sites.length === 1 ? "" : "s"}`,
    );
    for (const site of sites.slice(0, SNIPPETS_PER_SYMBOL)) {
      let lines = sources.get(site.path);
      if (!lines) {
        lines = (await read(site.path))?.split("\n") ?? [];
        sources.set(site.path, lines);
      }
      const from = Math.max(1, site.line - SNIPPET_RADIUS);
      const to = Math.min(lines.length, site.line + SNIPPET_RADIUS);
      const body = [];
      for (let n = from; n <= to; n++)
        body.push(`${String(n).padStart(5)} ${n === site.line ? ">" : " "} ${lines[n - 1] ?? ""}`);
      snippets.push(
        `${site.path}:${site.line}${site.confidence === "name" ? " (name match only)" : ""}\n${body.join("\n")}`,
      );
    }
    if (sites.length > SNIPPETS_PER_SYMBOL) snippets.push(`…and ${sites.length - SNIPPETS_PER_SYMBOL} more`);
  }

  return {
    context: {
      changes,
      callers,
      complete: index.complete,
      covered: new Set(
        files.filter((f) => after.has(f.path) || before.has(f.previousPath ?? f.path)).map((f) => f.path),
      ),
    },
    callerSnippets: snippets.join("\n\n"),
  };
}

/** Languages whose callers the graph can find across files. */
const CALLERS_READY = new Set(["typescript", "tsx", "python", "go"]);

/** Changed files the graph can't trace callers for yet (e.g. Go, PHP), for "Not checked". */
export function filesOutsideGraph(files: DiffFile[]): string[] {
  return files
    .filter((f) => {
      const language = languageOf(f.path);
      return fileKind(f.path) === "code" && (!language || !CALLERS_READY.has(language));
    })
    .map((f) => f.path);
}
