import type { Evidence } from "@alden/schema";
import picomatch from "picomatch";
import { addedLines, type DiffFile } from "../diff/parse.js";
import { fileKind, isLockfile, sensitiveMatcher } from "../queue/files.js";
import { type DependencyChange, diffDependencies, isManifest } from "./dependencies.js";
import { findSecrets } from "./secrets.js";
import { type SignatureChange, signatureChanges } from "./signatures.js";
import { type Check, type CheckOutcome, MAX_EVIDENCE } from "./types.js";

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
    const code = changed(files).filter((f) => fileKind(f.path) === "code");
    const tests = files.filter((f) => fileKind(f.path) === "test");
    if (code.length === 0) return skipped("No code changed.");
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
      severity: destructive.length > 0 ? "high" : "medium",
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
      return `${change.major ? "major upgrade" : "updated"} ${change.to.name} ${change.from.version} → ${change.to.version} in ${path}`;
  }
}

/** The added line that names the package, so the evidence points at it. */
function lineNaming(file: DiffFile | undefined, name: string): number | undefined {
  if (!file) return undefined;
  return addedLines(file).find((l) => l.text.includes(name))?.line;
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
          if (change.dep.group === "runtime" || change.dep.group === "peer") risky = true;
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
      severity: "high",
      summary: `${evidence.length} likely secret${evidence.length === 1 ? "" : "s"} in added lines. If real, rotate them: they're in the branch history now, even if removed later.`,
      evidence: capped(evidence),
    };
  },
};

// ─── Public signatures ───────────────────────────────────────────────────────────────────────────

function describeSignature(change: SignatureChange): Evidence {
  switch (change.kind) {
    case "changed":
      return {
        text: `changed: ${change.before.signature} → ${change.after.signature}`,
        anchor: { path: change.after.path, ...(change.after.line ? { line: change.after.line } : {}) },
      };
    case "removed":
      return { text: `removed: ${change.before.signature}`, anchor: { path: change.before.path } };
    case "moved":
      return {
        text: `moved ${change.after.name} from ${change.before.path}`,
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
  run({ files }) {
    const changes = signatureChanges(files);
    const breaking = changes.filter((c) => c.kind === "changed" || c.kind === "removed");
    const moved = changes.filter((c) => c.kind === "moved");
    const added = changes.filter((c) => c.kind === "added");

    if (breaking.length === 0 && moved.length === 0) {
      return passed(
        added.length > 0
          ? `No public signatures changed; ${added.length} new public declaration${added.length === 1 ? "" : "s"}.`
          : "No public signatures changed.",
        capped(added.map(describeSignature)),
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
      summary: `${parts.join(", ")}. Callers outside this diff may need updating; Alden can't see them until the code graph lands.`,
      evidence: capped([...breaking, ...moved].map(describeSignature)),
    };
  },
};

/** Every check, in the order a briefing lists them. */
export const CHECKS: Check[] = [
  ciCheck,
  secretsCheck,
  testsCheck,
  migrationsCheck,
  signaturesCheck,
  dependenciesCheck,
  configCheck,
  sensitivePathsCheck,
];
