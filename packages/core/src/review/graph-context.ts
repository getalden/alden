import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DiffFile } from "../diff/parse.js";
import { changedNewLines, changedSymbols, loadChangeSymbols } from "../graph/changes.js";
import type { FileSymbols } from "../graph/extract.js";
import { indexRepo } from "../graph/index-repo.js";
import { languageOf } from "../graph/parser.js";
import { type CallSite, CodeGraph } from "../graph/query.js";
import { createResolver, dirOf, loadResolverConfig, type Resolver } from "../graph/resolve.js";
import { fileKind } from "../queue/files.js";
import { type GraphContext, type ModuleChange, symbolKey, tracksCallers } from "./types.js";

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
  const resolverConfig = await loadResolverConfig(root, tracked);
  const resolve = createResolver(index.files.keys(), resolverConfig);
  const graph = new CodeGraph(index.files, resolve);

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
    if (!tracksCallers(change) || change.change === "added") continue;
    callers.set(symbolKey(change), productionFirst(graph.callersOf(change, exclude)));
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
        `${site.path}:${site.line}${site.via ? ` (through ${site.via})` : ""}${site.confidence === "name" ? " (name match only)" : ""}\n${body.join("\n")}`,
      );
    }
    if (sites.length > SNIPPETS_PER_SYMBOL) snippets.push(`…and ${sites.length - SNIPPETS_PER_SYMBOL} more`);
  }

  // Code the parser doesn't read but that names PHP classes in full: service configuration (Symfony's YAML and XML,
  // which a changed constructor or a removed class breaks) and Blade templates (`{{ \\App\\Support\\Str::x() }}`).
  for (const change of changes) {
    if (!change.path.endsWith(".php") || !change.exported || change.change === "added") continue;
    const namespace = (after.get(change.path) ?? before.get(change.path))?.phpNamespace;
    const className = change.container ?? change.name;
    const fqn = namespace ? `${namespace}\\${className}` : className;
    const constructorChanged = change.name === "__construct" && change.container !== undefined;
    const removedClass = !change.container && change.kind === "class" && change.change === "removed";
    const sites: CallSite[] = [];
    if (constructorChanged || removedClass)
      sites.push(...(await textMentions(root, tracked, CONFIG_FILE, fqn, "", exclude)));
    if (change.container && !constructorChanged) {
      sites.push(...(await textMentions(root, tracked, BLADE_FILE, fqn, `::${change.name}\\s*\\(`, exclude)));
    } else if (removedClass) {
      sites.push(...(await textMentions(root, tracked, BLADE_FILE, fqn, "", exclude)));
    }
    if (sites.length === 0) continue;
    const key = symbolKey(change);
    callers.set(key, productionFirst([...(callers.get(key) ?? []), ...sites]));
    const label = `${className}${change.container ? `::${change.name}` : ""}`;
    snippets.push(
      `### ${label} is named in config or templates\n${sites.map((s) => `${s.path}:${s.line}`).join("\n")}`,
    );
  }

  // Moved and deleted modules: whatever still imports the old path breaks, as callers of a removed symbol do.
  const gone = files.filter(
    (f) => (f.status === "removed" || f.status === "renamed") && languageOf(f.previousPath ?? f.path) !== undefined,
  );
  const modules: ModuleChange[] = [];
  if (gone.length > 0) {
    const oldPaths = gone.map((f) => f.previousPath ?? f.path);
    const resolveOld = createResolver([...index.files.keys(), ...oldPaths], resolverConfig);
    for (const file of gone) {
      const path = file.previousPath ?? file.path;
      const importers = importersOf(index.files, path, resolve, resolveOld, exclude);
      modules.push({ path, ...(file.status === "renamed" ? { movedTo: file.path } : {}), importers });
      if (importers.length === 0) continue;
      const what = file.status === "renamed" ? `moved to ${file.path}` : "deleted";
      snippets.push(
        `### ${path} (${what}) is still imported in ${importers.length} place${importers.length === 1 ? "" : "s"}\n${importers.map((s) => `${s.path}:${s.line}`).join("\n")}`,
      );
    }
  }

  // Who imports each changed file, for the related files a briefing suggests beside each place.
  const importers = graph.importersOf(
    files.filter((f) => f.status !== "removed" && index.files.has(f.path)).map((f) => f.path),
    exclude,
  );

  return {
    context: {
      changes,
      callers,
      complete: index.complete,
      modules,
      importers,
      covered: new Set(
        files.filter((f) => after.has(f.path) || before.has(f.previousPath ?? f.path)).map((f) => f.path),
      ),
    },
    callerSnippets: snippets.join("\n\n"),
  };
}

/**
 * Imports that reached `oldPath` before the change and reach nothing now: `resolveOld` knows the old path, `resolve`
 * only today's files. An import that now resolves elsewhere (`./pricing` finding `pricing/index.ts`) still works. Go
 * imports name a package, so they match the old file's directory once no package is left there. Python's
 * `from pkg import module` names the module after the package.
 */
function importersOf(
  index: Map<string, FileSymbols>,
  oldPath: string,
  resolve: Resolver,
  resolveOld: Resolver,
  exclude: Map<string, Set<number>>,
): CallSite[] {
  const sites: CallSite[] = [];
  const targets = new Set([oldPath, ...(oldPath.endsWith(".go") ? [dirOf(oldPath)] : [])]);
  for (const [path, symbols] of index) {
    for (const imp of symbols.imports) {
      const specifiers = [imp.from];
      if (path.endsWith(".py") && imp.imported !== "*")
        specifiers.push(`${imp.from}${imp.from.endsWith(".") ? "" : "."}${imp.imported}`);
      const broken = specifiers.some((spec) => {
        const before = resolveOld(path, spec);
        return before !== undefined && targets.has(before) && resolve(path, spec) === undefined;
      });
      if (broken && !exclude.get(path)?.has(imp.line) && !sites.some((s) => s.path === path && s.line === imp.line))
        sites.push({ path, line: imp.line, confidence: "import" });
    }
  }
  return productionFirst(sites.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line));
}

/** Languages whose callers the graph can find across files. */
const CALLERS_READY = new Set(["typescript", "tsx", "python", "go", "php"]);

/** Production code first: that's where a break hurts; tests follow. Within each, sure matches before name-only ones. */
const productionFirst = (sites: CallSite[]) =>
  sites.sort(
    (a, b) =>
      Number(fileKind(a.path) === "test") - Number(fileKind(b.path) === "test") ||
      Number(a.confidence === "name") - Number(b.confidence === "name"),
  );

/** Service config: YAML and XML. Blade templates, which the parser skips. */
const CONFIG_FILE = /\.(ya?ml|xml)$/;
const BLADE_FILE = /\.blade\.php$/;

/**
 * Lines in files matching `files` that name a PHP class in full, followed by `after` (a regex source, e.g. a static
 * call): `App\\Mailer\\Sender:` in services.yaml, `class="App\\Mailer\\Sender"` in XML, `\\App\\Str::x(` in Blade.
 * YAML's quoted form doubles the backslashes. Vendored code and files over 1 MB are skipped.
 */
export async function textMentions(
  root: string,
  tracked: string[],
  files: RegExp,
  fqn: string,
  after = "",
  exclude: Map<string, Set<number>> = new Map(),
): Promise<CallSite[]> {
  const spellings = [fqn, fqn.replace(/\\/g, "\\\\")].map(escapeRegExp).join("|");
  const pattern = new RegExp(`(^|[^\\w\\\\])\\\\?(${spellings})(?![\\w\\\\])${after}`);
  const sites: CallSite[] = [];
  for (const path of tracked) {
    if (!files.test(path) || /(^|\/)(vendor|node_modules)\//.test(path)) continue;
    const text = await readFile(join(root, path), "utf8").catch(() => "");
    if (text.length > 1_000_000 || !text.includes(fqn.split("\\").at(-1) ?? fqn)) continue;
    text.split("\n").forEach((content, i) => {
      if (pattern.test(content) && !exclude.get(path)?.has(i + 1))
        sites.push({ path, line: i + 1, confidence: "import" });
    });
  }
  return sites;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Changed files the graph can't trace callers for yet (e.g. Go, PHP), for "Not checked". */
export function filesOutsideGraph(files: DiffFile[]): string[] {
  return files
    .filter((f) => {
      const language = languageOf(f.path);
      return fileKind(f.path) === "code" && (!language || !CALLERS_READY.has(language));
    })
    .map((f) => f.path);
}
