/**
 * Measures how well the code graph finds the callers a signature change breaks, on a real repo's history, with no
 * labels and no model: `pnpm eval:callers <clone> [--since 2024-01-01] [--limit 40] [--languages ruby,swift]
 * [--json out.json] [--verbose] [--commit <sha>]`.
 *
 * It looks for commits that changed a function's or method's signature and, in the same commit, edited other files
 * that call it. Those edits are the answer key: the callers the author had to update. Each case replays the commit
 * without them (the parent commit, plus only the file that defines the symbol, at its new version) and asks the graph
 * for the symbol's callers outside the diff. A caller file counts as found when the graph lists a call site in it.
 *
 * The key is a little noisy: a word match on the old lines, so a same-named method of another class edited in the
 * same commit counts as a caller too. Read the misses (`--verbose`) before blaming the graph. Commits touching more
 * than 40 files and test-only callers are skipped; a merge commit counts as the change its branch brought in. The index cache under
 * ~/.alden/index is shared with real reviews, so later runs on the same clone are fast.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraphReview, fileKind, languageOf, parseUnifiedDiff } from "../packages/core/src/index.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const clone = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
if (!clone) throw new Error("Usage: pnpm eval:callers <clone> [--since 2024-01-01] [--limit 40] [--json out.json]");
const since = flag("--since") ?? "2024-01-01";
const limit = Number(flag("--limit") ?? 40);
const verbose = args.includes("--verbose");
// `--languages ruby,kotlin`: only symbols defined in these (callers may be in any language the graph reads).
const languages = flag("--languages") ? new Set(flag("--languages")?.split(",")) : undefined;
const MAX_FILES = 40;

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

/** Declarations, so an override or a same-named definition in another file isn't taken for a call. */
const DECLARATION =
  /^\s*(?:[\w@]+\s+)*(?:def|func|fun|function)\s|^\s*(?:public|private|protected|internal)\s[^=(]*\b\w+\s*\(|^\s*(?!(?:return|new|else|throw|if|while|for|switch|case|await|try)\b)(?:[\w@<>[\],.?]+\s+)+\w+\s*\([^;=]*$/;
const GENERIC = new Set([
  "call",
  "perform",
  "run",
  "execute",
  "process",
  "handle",
  "invoke",
  "apply",
  "build",
  "create",
  "update",
]);
const IMPORT = /^\s*(import|require|use)\b/;
const withoutStrings = (line: string) => line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const COMMENT = /^\s*(#|\/\/|\/?\*)/;
const CONSTRUCTORS = new Set(["initialize", "init", "constructor", "__construct"]);

interface Case {
  commit: string;
  subject: string;
  language: string;
  symbol: string;
  path: string;
  expected: { path: string; lines: number[] }[];
  found: string[];
  missed: string[];
  /** Other files the graph listed: callers the commit didn't need to touch, or noise. */
  others: number;
  nameOnly: number;
  seconds: number;
}

const only = flag("--commit");
const commits = git(
  clone,
  "log",
  "--first-parent",
  `--since=${since}`,
  "--format=%H%x1f%s",
  only ? `${only}^!` : "HEAD",
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => l.split("\x1f") as [string, string]);

const cases: Case[] = [];
const worktree = mkdtempSync(join(tmpdir(), "alden-eval-callers-"));
git(clone, "worktree", "add", "--detach", "--force", worktree, "HEAD");
try {
  for (const [sha, subject] of commits) {
    if (cases.length >= limit) break;
    const diff = parseUnifiedDiff(git(clone, "diff", "--no-color", "-M", `${sha}^`, sha));
    if (diff.length > MAX_FILES) continue;
    const code = diff.filter((f) => languageOf(f.path) && f.status !== "removed" && fileKind(f.path) === "code");
    if (code.length < 2) continue;

    // Cheap pre-filter before any checkout: a declaration line removed and re-added with the same name.
    const candidates = code.filter((f) => {
      if (f.status !== "modified" || (languages && !languages.has(languageOf(f.path) ?? ""))) return false;
      const removed = new Set<string>();
      const added = new Set<string>();
      for (const h of f.hunks)
        for (const l of h.lines) {
          if (l.kind === "context" || !DECLARATION.test(l.text)) continue;
          const name = l.text.match(/(\w+)\s*[(<]/)?.[1];
          if (name) (l.kind === "del" ? removed : added).add(name);
        }
      return [...removed].some((n) => added.has(n));
    });
    if (candidates.length === 0) continue;

    git(worktree, "checkout", "--quiet", "--force", "--detach", `${sha}^`);
    const oldText = (path: string) => {
      try {
        return readFileSync(join(worktree, path), "utf8");
      } catch {
        return "";
      }
    };
    for (const def of candidates) {
      const started = Date.now();
      git(worktree, "checkout", "--quiet", sha, "--", def.path);
      try {
        const files = parseUnifiedDiff(git(clone, "diff", "--no-color", `${sha}^`, sha, "--", def.path));
        const review = await buildGraphReview(worktree, files);
        const defPackage = readFileSync(join(worktree, def.path), "utf8").match(/^package\s+([\w.]+)/m)?.[1] ?? "";
        for (const change of review.context.changes) {
          if (change.change !== "modified" || (change.kind !== "method" && change.kind !== "function")) continue;
          if (!change.signature || !change.previousSignature || change.signature === change.previousSignature) continue;
          const constructs = CONSTRUCTORS.has(change.name) || change.name === change.container;
          const word = constructs ? change.container : change.name;
          if (!word || word.length < 4) continue;
          // A constructor is called as `Foo.new`, `Foo(` or `new Foo(`, not wherever the class is named. A method
          // only where it's called or referenced: `x.word`, `word(`, `word {`, Ruby's `word arg` and `:word`, Kotlin's
          // `::word`. Not as a property, parameter or named argument (`word: …`, `word = …`).
          const pattern = new RegExp(
            constructs
              ? `\\b${word}(\\.new\\b|\\s*\\()`
              : `(?:\\.|::|:|&\\.|\\?\\.)${word}\\b(?!\\s*(?::[^:]|=[^=~]))|(?<![\\w.:$])${word}\\s*[({]|^\\s*${word}\\s+[\\w'"@:]`,
          );
          // The file calls a same-named function it imports from elsewhere (`kotlin.concurrent.withLock`).
          const importsOther = (text: string) =>
            new RegExp(`^import\\s+(static\\s+)?[\\w.]+\\.${word}\\s*;?\\s*$`, "m").test(text) &&
            !new RegExp(`^import\\s+(static\\s+)?${escapeRegExp(defPackage)}\\.(\\w+\\.)?${word}\\b`, "m").test(text);
          // A name every service has (`call`, `perform`) only counts in files that name the class too.
          const classWord = change.container ? new RegExp(`\\b${change.container}\\b`) : undefined;
          const generic = GENERIC.has(change.name) && classWord !== undefined;
          const expected = code
            .filter((f) => f.path !== def.path)
            .filter((f) => !generic || classWord?.test(oldText(f.previousPath ?? f.path)))
            .filter((f) => !importsOther(oldText(f.previousPath ?? f.path)))
            .map((f) => ({
              path: f.previousPath ?? f.path,
              lines: f.hunks.flatMap((h) =>
                h.lines.flatMap((l) =>
                  l.kind === "del" &&
                  l.oldLine &&
                  pattern.test(withoutStrings(l.text)) &&
                  !IMPORT.test(l.text) &&
                  !DECLARATION.test(l.text) &&
                  !COMMENT.test(l.text)
                    ? [l.oldLine]
                    : [],
                ),
              ),
            }))
            .filter((e) => e.lines.length > 0);
          if (expected.length === 0) continue;
          const sites =
            review.context.callers.get(
              `${change.path}#${change.container ? `${change.container}.` : ""}${change.name}`,
            ) ?? [];
          const sitePaths = new Set(sites.map((s) => s.path));
          const expectedPaths = new Set(expected.map((e) => e.path));
          cases.push({
            commit: sha.slice(0, 10),
            subject: subject.slice(0, 80),
            language: languageOf(change.path) ?? "",
            symbol: `${change.container ? `${change.container}.` : ""}${change.name}`,
            path: change.path,
            expected,
            found: [...expectedPaths].filter((p) => sitePaths.has(p)),
            missed: [...expectedPaths].filter((p) => !sitePaths.has(p)),
            others: [...sitePaths].filter((p) => !expectedPaths.has(p)).length,
            nameOnly: sites.filter((s) => s.confidence === "name").length,
            seconds: (Date.now() - started) / 1000,
          });
          const c = cases.at(-1);
          if (c)
            console.log(
              `${c.commit} ${c.symbol.padEnd(40).slice(0, 40)} found ${c.found.length}/${c.expected.length}  +${c.others} other files  ${c.seconds.toFixed(1)}s${verbose && c.missed.length ? `\n    missed: ${c.missed.join(", ")}` : ""}`,
            );
        }
      } finally {
        git(worktree, "checkout", "--quiet", `${sha}^`, "--", def.path);
      }
    }
  }
} finally {
  git(clone, "worktree", "remove", "--force", worktree);
  rmSync(worktree, { recursive: true, force: true });
}

const expected = cases.reduce((n, c) => n + c.expected.length, 0);
const found = cases.reduce((n, c) => n + c.found.length, 0);
const byLanguage = Object.fromEntries(
  [...new Set(cases.map((c) => c.language))].sort().map((language) => {
    const list = cases.filter((c) => c.language === language);
    const want = list.reduce((n, c) => n + c.expected.length, 0);
    return [language, `${list.reduce((n, c) => n + c.found.length, 0)}/${want} caller files in ${list.length} cases`];
  }),
);
// Overloads and same-named methods changed in one commit are one case each; count each caller file once per name too.
const distinct = new Map<string, boolean>();
for (const c of cases) {
  const name = c.symbol.split(".").at(-1);
  for (const e of c.expected) {
    const id = `${c.commit} ${name} ${e.path}`;
    distinct.set(id, distinct.get(id) === true || c.found.includes(e.path));
  }
}
const isTest = (id: string) => /(^|\/)(test|tests|spec|androidTest)\/|Tests?\.\w+$|_spec\.rb$|_test\.\w+$/.test(id);
const share = (ids: string[]) => `${ids.filter((id) => distinct.get(id)).length}/${ids.length}`;
const summary = {
  clone,
  byLanguage,
  cases: cases.length,
  callerFiles: expected,
  found,
  recall: expected === 0 ? null : Number((found / expected).toFixed(3)),
  distinctCallers: share([...distinct.keys()]),
  distinctNonTestCallers: share([...distinct.keys()].filter((id) => !isTest(id.split(" ")[2] ?? ""))),
  casesFullyFound: cases.filter((c) => c.missed.length === 0).length,
  medianOtherFiles: [...cases.map((c) => c.others)].sort((a, b) => a - b)[Math.floor(cases.length / 2)] ?? 0,
  medianSeconds: [...cases.map((c) => c.seconds)].sort((a, b) => a - b)[Math.floor(cases.length / 2)] ?? 0,
};
console.log(`\n${JSON.stringify(summary, null, 2)}`);
const out = flag("--json");
if (out) writeFileSync(out, `${JSON.stringify({ summary, cases }, null, 2)}\n`);
