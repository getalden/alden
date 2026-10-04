import type { Evidence } from "@alden/schema";
import picomatch from "picomatch";
import { isPureRename, onlyCommentsChanged } from "../diff/comments.js";
import { addedLines, type DiffFile } from "../diff/parse.js";
import { fileKind, isLockfile, sensitiveMatcher } from "../queue/files.js";
import { type DependencyChange, diffDependencies, isManifest } from "./dependencies.js";
import { AI_INSTRUCTION_FILE, findInjection } from "./injection.js";
import { findSecrets } from "./secrets.js";
import { type SignatureChange, signatureChanges } from "./signatures.js";
import { type Check, type CheckOutcome, MAX_EVIDENCE, symbolKey } from "./types.js";

const passed = (summary: string, evidence: Evidence[] = []): CheckOutcome => ({
  status: "passed",
  severity: "info",
  summary,
  evidence,
});
const skipped = (summary: string): CheckOutcome => ({ status: "skipped", severity: "info", summary, evidence: [] });

/** Caps an evidence list, noting how many were left out. */
function capped(items: Evidence[]): Evidence[] {
  if (items.length <= MAX_EVIDENCE) return items;
  return [...items.slice(0, MAX_EVIDENCE), { text: `and ${items.length - MAX_EVIDENCE} more` }];
}

/** Points at a file, at its first added line when it has one. */
function fileEvidence(file: DiffFile, text: string = file.path): Evidence {
  const first = addedLines(file)[0];
  return { text, anchor: first ? { path: file.path, line: first.line } : { path: file.path } };
}

const changed = (files: DiffFile[]) => files.filter((f) => f.status !== "removed");

// ─── CI ──────────────────────────────────────────────────────────────────────────────────────────

export const ciCheck: Check = {
  id: "ci.status",
  title: "CI status",
  heuristic: false,
  run({ target, pr }) {
    if (target.kind === "local" || !pr) return skipped("CI doesn't run on local changes.");
    switch (pr.ci) {
      case "success":
        return passed("All CI checks passed on the latest commit.");
      case "failure":
        return {
          status: "flagged",
          severity: "high",
          summary: `CI is failing on the latest commit. ${pr.author ? `Ask @${pr.author} to fix it` : "The author needs to fix it"} before a full review.`,
          evidence: [{ text: `Status rollup for ${target.headRef}: failing` }],
        };
      case "pending":
        return skipped("CI is still running on the latest commit.");
      default:
        return skipped("No CI ran on this PR, so nothing has built or tested it.");
    }
  },
};

// ─── Tests ───────────────────────────────────────────────────────────────────────────────────────

export const testsCheck: Check = {
  id: "tests.missing",
  title: "Code changed without tests",
  heuristic: true,
  run({ files }) {
    const touched = changed(files).filter((f) => fileKind(f.path) === "code");
    // A comment, a blank line or a move can't change behaviour, so it needs no test.
    const code = touched.filter((f) => !isPureRename(f) && !onlyCommentsChanged(f));
    const tests = files.filter((f) => fileKind(f.path) === "test");
    if (code.length === 0) {
      return skipped(
        touched.length > 0 ? "Only comments, blank lines or file moves changed in code." : "No code changed.",
      );
    }
    if (tests.length > 0) {
      return passed(
        `${tests.length} test file${tests.length === 1 ? "" : "s"} changed alongside ${code.length} code file${code.length === 1 ? "" : "s"}.`,
        capped(tests.map((f) => fileEvidence(f, `test changed: ${f.path}`))),
      );
    }
    return {
      status: "flagged",
      severity: "medium",
      summary: `${code.length} code file${code.length === 1 ? "" : "s"} changed and no tests were added or updated.`,
      evidence: capped(code.map((f) => fileEvidence(f, `no matching test change: ${f.path}`))),
    };
  },
};

// ─── Migrations ──────────────────────────────────────────────────────────────────────────────────

const MIGRATION_PATHS = picomatch(
  [
    "**/migrations/**", // Django, Laravel (database/migrations), Symfony, Rails-style
    "**/migrate/**",
    "**/*.{up,down}.sql", // golang-migrate
    "**/schema.prisma",
    "**/drizzle/**/*.sql",
    "**/db/schema.rb",
  ],
  { dot: true },
);

/** Operations that lose or reshape data if the migration runs. */
const DESTRUCTIVE = [
  /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|SCHEMA|DATABASE)\b/i,
  /\bTRUNCATE\b/i,
  /\bALTER\s+TABLE\b.*\b(DROP|RENAME|ALTER\s+COLUMN|MODIFY)\b/i,
  /\bDELETE\s+FROM\b/i,
  /->(dropColumn|dropIfExists|drop|renameColumn|dropForeign|dropIndex)\s*\(/, // Laravel
  /Schema::drop(IfExists)?\s*\(/,
  /migrations\.(RemoveField|DeleteModel|RenameField|RenameModel|AlterField)\s*\(/, // Django
  /\$this->addSql\(\s*['"](DROP|ALTER TABLE .* DROP)/i, // Doctrine
];

export const migrationsCheck: Check = {
  id: "migrations.changed",
  title: "Database migrations",
  heuristic: true,
  run({ files }) {
    const migrations = changed(files).filter((f) => MIGRATION_PATHS(f.path));
    if (migrations.length === 0) return passed("No database migrations changed.");

    const destructive: Evidence[] = [];
    for (const file of migrations) {
      for (const { line, text } of addedLines(file)) {
        if (DESTRUCTIVE.some((pattern) => pattern.test(text))) {
          destructive.push({ text: `may lose data: ${text.trim().slice(0, 100)}`, anchor: { path: file.path, line } });
        }
      }
    }
    const count = `${migrations.length} migration${migrations.length === 1 ? "" : "s"}`;
    return {
      status: "flagged",
      severity: destructive.length > 0 ? "critical" : "medium",
      summary:
        destructive.length > 0
          ? `${count} changed, with operations that can drop or reshape data. Check they're reversible and safe to run on production data.`
          : `${count} changed. Check they're reversible and safe to run while the old code is still deployed.`,
      evidence: capped([...destructive, ...migrations.map((f) => fileEvidence(f, `migration: ${f.path}`))]),
    };
  },
};

// ─── Config and environment ──────────────────────────────────────────────────────────────────────

const CONFIG_PATHS = picomatch(
  [
    "**/.env*",
    "**/config/**",
    "**/settings.py",
    "**/settings/*.py",
    "**/*.config.{js,cjs,mjs,ts}",
    "**/{Dockerfile,Containerfile}",
    "**/docker-compose*.{yml,yaml}",
    "**/compose*.{yml,yaml}",
    ".github/workflows/**",
    "**/{app,serverless,vercel,netlify,fly}.{json,toml,yaml,yml}",
    "**/*.tf",
    "**/{helm,k8s,kubernetes,deploy,deployment}/**",
  ],
  { dot: true },
);

/** New references to environment variables, per language. Group 1 is the variable name. */
const ENV_REFERENCES = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/, // Node
  /process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/, // Vite
  /os\.environ(?:\.get)?\s*[[(]\s*['"]([A-Z_][A-Z0-9_]*)['"]/, // Python
  /os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/,
  /\benv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/, // Laravel
  /\$_(?:ENV|SERVER)\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/, // PHP
  /%env\((?:[a-z]+:)*([A-Z_][A-Z0-9_]*)\)%/, // Symfony
  /os\.(?:Getenv|LookupEnv)\(\s*"([A-Z_][A-Z0-9_]*)"/, // Go
];

export const configCheck: Check = {
  id: "config.changed",
  title: "Configuration and environment",
  heuristic: true,
  run({ files }) {
    const configFiles = changed(files).filter((f) => CONFIG_PATHS(f.path) && fileKind(f.path) !== "test");

    const seen = new Set<string>();
    const newVariables: Evidence[] = [];
    for (const file of changed(files)) {
      if (fileKind(file.path) === "test") continue;
      for (const { line, text } of addedLines(file)) {
        for (const pattern of ENV_REFERENCES) {
          const name = pattern.exec(text)?.[1];
          if (name && !seen.has(name)) {
            seen.add(name);
            newVariables.push({ text: `reads environment variable ${name}`, anchor: { path: file.path, line } });
          }
        }
      }
    }

    if (configFiles.length === 0 && newVariables.length === 0) {
      return passed("No configuration files or environment variables changed.");
    }
    const parts = [
      configFiles.length > 0 && `${configFiles.length} config file${configFiles.length === 1 ? "" : "s"} changed`,
      newVariables.length > 0 &&
        `${newVariables.length} environment variable${newVariables.length === 1 ? "" : "s"} newly read`,
    ].filter(Boolean);
    return {
      status: "flagged",
      severity: "medium",
      summary: `${parts.join(" and ")}. Make sure every environment (staging, production, CI) has what it needs.`,
      evidence: capped([...newVariables, ...configFiles.map((f) => fileEvidence(f, `config: ${f.path}`))]),
    };
  },
};

// ─── Sensitive paths ─────────────────────────────────────────────────────────────────────────────

export const sensitivePathsCheck: Check = {
  id: "paths.sensitive",
  title: "Sensitive paths",
  heuristic: false,
  run({ files, config }) {
    const matches = sensitiveMatcher(config.queue.sensitivePaths);
    const hits = files.filter((f) => matches(f.path) || (f.previousPath !== undefined && matches(f.previousPath)));
    if (hits.length === 0) return passed("Nothing under your sensitive paths changed.");
    return {
      status: "flagged",
      severity: "medium",
      summary: `${hits.length} file${hits.length === 1 ? "" : "s"} under your sensitive paths changed.`,
      evidence: capped(hits.map((f) => fileEvidence(f, `${f.status}: ${f.path}`))),
    };
  },
};

// ─── Dependencies ────────────────────────────────────────────────────────────────────────────────

function describeChange(change: DependencyChange, path: string): string {
  switch (change.kind) {
    case "added":
      return `added ${change.dep.name} ${change.dep.version} (${change.dep.group}) in ${path}`;
    case "removed":
      return `removed ${change.dep.name} (${change.dep.group}) from ${path}`;
    case "changed":
      return `${change.major ? "major upgrade" : "updated"} ${change.to.name} ${change.from.version} → ${change.to.version}${change.to.group === "override" ? " (override)" : ""} in ${path}`;
  }
}

/** The added line that names the package, so the evidence points at it. A nested override ("a > b") is on b's line. */
function lineNaming(file: DiffFile | undefined, name: string): number | undefined {
  if (!file) return undefined;
  const last = name.split(" > ").at(-1) ?? name;
  return addedLines(file).find((l) => l.text.includes(last))?.line;
}

export const dependenciesCheck: Check = {
  id: "dependencies.changed",
  title: "Dependencies",
  heuristic: false,
  run({ files, manifests }) {
    const manifestFiles = files.filter((f) => isManifest(f.path));
    if (manifestFiles.length === 0) return passed("No dependency manifests changed.");
    if (!manifests) return skipped("Manifests changed, but Alden couldn't read them to compare dependencies.");

    const evidence: Evidence[] = [];
    const counts = { added: 0, removed: 0, updated: 0, major: 0, unreadable: 0 };
    let risky = false;

    for (const snapshot of manifests) {
      let changes: DependencyChange[];
      try {
        changes = diffDependencies(snapshot);
      } catch {
        counts.unreadable++;
        evidence.push({ text: `couldn't parse ${snapshot.path}`, anchor: { path: snapshot.path } });
        continue;
      }
      const file = files.find((f) => f.path === snapshot.path);
      for (const change of changes) {
        const name = change.kind === "changed" ? change.to.name : change.dep.name;
        const line = change.kind === "removed" ? undefined : lineNaming(file, name);
        evidence.push({
          text: describeChange(change, snapshot.path),
          anchor: line ? { path: snapshot.path, line } : { path: snapshot.path },
        });
        if (change.kind === "added") {
          counts.added++;
          // A new override forces a version on every package that depends on it, so it's as risky as a new package.
          if (change.dep.group === "runtime" || change.dep.group === "peer" || change.dep.group === "override")
            risky = true;
        } else if (change.kind === "removed") counts.removed++;
        else if (change.major) {
          counts.major++;
          risky = true;
        } else counts.updated++;
      }
    }

    if (evidence.length === 0) return passed("Manifests changed, but no dependencies did.");

    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const parts = [
      counts.added > 0 && `${plural(counts.added, "dependency")} added`.replace("dependencys", "dependencies"),
      counts.major > 0 && plural(counts.major, "major upgrade"),
      counts.updated > 0 && `${counts.updated} updated`,
      counts.removed > 0 && `${counts.removed} removed`,
      counts.unreadable > 0 && `${plural(counts.unreadable, "manifest")} unreadable`,
    ].filter(Boolean);
    return {
      status: "flagged",
      severity: risky ? "medium" : "low",
      summary: `${parts.join(", ")}.${risky ? " New runtime packages and major upgrades deserve a look at what they bring in." : ""}`,
      evidence: capped(evidence),
    };
  },
};

// ─── Secrets ─────────────────────────────────────────────────────────────────────────────────────

export const secretsCheck: Check = {
  id: "secrets.likely",
  title: "Likely secrets",
  heuristic: true,
  run({ files }) {
    const evidence: Evidence[] = [];
    for (const file of changed(files)) {
      if (file.binary || isLockfile(file.path)) continue;
      for (const { line, text } of addedLines(file)) {
        for (const finding of findSecrets(text)) {
          evidence.push({ text: `${finding.kind}: ${finding.masked}`, anchor: { path: file.path, line } });
        }
      }
    }
    if (evidence.length === 0) return passed("No likely secrets in the added lines.");
    return {
      status: "flagged",
      severity: "critical",
      summary: `${evidence.length} likely secret${evidence.length === 1 ? "" : "s"} in added lines. If real, rotate them: they're in the branch history now, even if removed later.`,
      evidence: capped(evidence),
    };
  },
};

// ─── Text aimed at AI reviewers ──────────────────────────────────────────────────────────────────

export const injectionCheck: Check = {
  id: "injection.ai",
  title: "Text aimed at AI reviewers",
  heuristic: true,
  run({ target, description, files }) {
    const evidence: Evidence[] = [];
    if (target.kind === "pr") {
      const inTitle = findInjection(target.title);
      if (inTitle) evidence.push({ text: `PR title: "${inTitle}"` });
      const inBody = description ? findInjection(description) : undefined;
      if (inBody) evidence.push({ text: `PR description: "${inBody}"` });
    }
    for (const file of changed(files)) {
      // Files written to instruct assistants (CLAUDE.md, Copilot rules) are meant to address them.
      if (file.binary || isLockfile(file.path) || AI_INSTRUCTION_FILE.test(file.path)) continue;
      for (const { line, text } of addedLines(file)) {
        const found = findInjection(text);
        if (found) evidence.push({ text: `"${found}"`, anchor: { path: file.path, line } });
      }
    }
    if (evidence.length === 0)
      return passed("Nothing in the title, description or added lines addresses an AI reviewer.");
    return {
      status: "flagged",
      severity: "high",
      summary: `${evidence.length} place${evidence.length === 1 ? "" : "s"} where the PR talks to AI reviewers rather than people (e.g. "ignore previous instructions"). Read it yourself, and don't trust an AI review of this PR until you have.`,
      evidence: capped(evidence),
    };
  },
};

// ─── Public signatures ───────────────────────────────────────────────────────────────────────────

const labelOf = (d: { name: string; container?: string }) => (d.container ? `${d.container}.${d.name}` : d.name);

function describeSignature(change: SignatureChange): Evidence {
  switch (change.kind) {
    case "changed":
      return {
        text: `${change.compatible ? "compatible change" : "changed"}: ${change.before.signature} → ${change.after.signature}`,
        anchor: { path: change.after.path, ...(change.after.line ? { line: change.after.line } : {}) },
      };
    case "removed":
      return { text: `removed: ${change.before.signature}`, anchor: { path: change.before.path } };
    case "moved":
      return {
        text: `moved ${labelOf(change.after)} from ${change.before.path}`,
        anchor: { path: change.after.path, ...(change.after.line ? { line: change.after.line } : {}) },
      };
    case "added":
      return {
        text: `added: ${change.after.signature}`,
        anchor: { path: change.after.path, ...(change.after.line ? { line: change.after.line } : {}) },
      };
  }
}

export const signaturesCheck: Check = {
  id: "signatures.changed",
  title: "Changed public signatures",
  heuristic: true,
  run({ files, graph }) {
    const changes = signatureChanges(files, graph);
    const breaking = changes.filter((c) => (c.kind === "changed" && !c.compatible) || c.kind === "removed");
    const compatible = changes.filter((c) => c.kind === "changed" && c.compatible);
    const moved = changes.filter((c) => c.kind === "moved");
    const added = changes.filter((c) => c.kind === "added");

    if (breaking.length === 0 && moved.length === 0) {
      const notes = [
        compatible.length > 0 &&
          `${compatible.length} gained optional parameter${compatible.length === 1 ? "" : "s"}, which existing calls don't need to pass`,
        added.length > 0 && `${added.length} new public declaration${added.length === 1 ? "" : "s"}`,
      ].filter(Boolean);
      return passed(
        notes.length > 0
          ? `No public signatures changed incompatibly; ${notes.join("; ")}.`
          : "No public signatures changed.",
        capped([...compatible, ...added].map(describeSignature)),
      );
    }
    const parts = [
      breaking.length > 0 &&
        `${breaking.length} public signature${breaking.length === 1 ? "" : "s"} changed or removed`,
      moved.length > 0 && `${moved.length} moved between files`,
    ].filter(Boolean);
    return {
      status: "flagged",
      severity: breaking.length > 0 ? "medium" : "low",
      summary: `${parts.join(", ")}. Callers outside this diff may need updating; see "Callers outside the diff" for where they are.`,
      evidence: capped([...breaking, ...moved, ...compatible].map(describeSignature)),
    };
  },
};

// ─── Callers outside the diff ────────────────────────────────────────────────────────────────────

const isTestEvidence = (e: Evidence) => e.anchor !== undefined && fileKind(e.anchor.path) === "test";

export const callersCheck: Check = {
  id: "callers.outside",
  title: "Callers outside the diff",
  heuristic: true,
  run({ files, graph, graphUnavailable }) {
    if (!graph) {
      return skipped(
        graphUnavailable ??
          "The code graph wasn't available for this review, so callers outside the diff weren't checked.",
      );
    }
    const publicChanges = graph.changes.filter((c) => c.exported && c.change !== "added");
    const goneModules = (graph.modules ?? []).filter((m) => m.importers.length > 0);
    if (publicChanges.length === 0 && goneModules.length === 0)
      return passed("No public functions, classes or methods changed.");

    // A removed definition, or one whose signature changed, can break its callers outright. Graph-based changes
    // name their type; diff-based ones only a name, which then matches any symbol of that name in the file.
    const signatureChanged = new Set(
      signatureChanges(files, graph).flatMap((c) =>
        c.kind === "changed" && !c.compatible
          ? [symbolKey(c.after)]
          : c.kind === "removed"
            ? [symbolKey(c.before)]
            : [],
      ),
    );
    const breaking: Evidence[] = [];
    const reaching: Evidence[] = [];
    let uncertain = 0;
    let breakingSymbols = 0;
    let reachingSymbols = 0;

    for (const change of publicChanges) {
      const sites = graph.callers.get(symbolKey(change)) ?? [];
      if (sites.length === 0) continue;
      const label = `${change.container ? `${change.container}.` : ""}${change.name}`;
      const isBreaking =
        change.change === "removed" ||
        signatureChanged.has(symbolKey(change)) ||
        signatureChanged.has(`${change.path}#${change.name}`);
      const why = change.change === "removed" ? "removed" : isBreaking ? "signature changed" : "changed";
      if (isBreaking) breakingSymbols++;
      else reachingSymbols++;
      for (const site of sites) {
        if (site.confidence === "name") uncertain++;
        const evidence: Evidence = {
          text: `calls ${label} (${why})${site.confidence === "name" ? ", name match only" : ""}`,
          anchor: { path: site.path, line: site.line },
        };
        (isBreaking ? breaking : reaching).push(evidence);
      }
    }

    // A moved or deleted file breaks whatever still imports it by its old path, like a removed symbol.
    for (const module of goneModules) {
      breakingSymbols++;
      const why = module.movedTo ? `moved to ${module.movedTo}` : "deleted";
      for (const site of module.importers) {
        breaking.push({ text: `imports ${module.path} (${why})`, anchor: { path: site.path, line: site.line } });
      }
    }

    // Callers in code before callers in tests, across symbols, so the capped evidence keeps the ones that matter.
    const codeFirst = (list: Evidence[]) => list.sort((a, b) => Number(isTestEvidence(a)) - Number(isTestEvidence(b)));
    codeFirst(breaking);
    codeFirst(reaching);

    const incomplete = graph.complete ? "" : " The index was cut short, so there may be more.";
    const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    if (breaking.length > 0) {
      const sure = breaking.some((e) => !e.text.endsWith("name match only"));
      return {
        status: "flagged",
        severity: sure ? "high" : "medium",
        summary: `${goneModules.length > 0 ? `${breakingSymbols} moved, removed or re-signed ${breakingSymbols === 1 ? "file or symbol" : "files or symbols"} still used from` : `${count(breakingSymbols, "removed or re-signed public symbol")} still called from`} ${count(breaking.length, "place")} this PR didn't change. Check each caller still works.${incomplete}`,
        evidence: capped([...breaking, ...reaching]),
      };
    }
    if (reaching.length > 0) {
      return {
        status: "flagged",
        severity: "low",
        summary: `${count(reachingSymbols, "changed public symbol")} called from ${count(reaching.length, "place")} outside the diff${uncertain > 0 ? ` (${uncertain} by name only)` : ""}. Behaviour changes reach them.${incomplete}`,
        evidence: capped(reaching),
      };
    }
    return passed(`Changed public code has no callers outside the diff.${incomplete}`);
  },
};

/** Every check, in the order a briefing lists them. */
export const CHECKS: Check[] = [
  ciCheck,
  secretsCheck,
  injectionCheck,
  testsCheck,
  migrationsCheck,
  signaturesCheck,
  callersCheck,
  dependenciesCheck,
  configCheck,
  sensitivePathsCheck,
];
