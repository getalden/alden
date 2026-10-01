import { execFile } from "node:child_process";
import { access, constants, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import {
  aldenHome,
  createGitHubClient,
  getViewer,
  isStandaloneBinary,
  languageOf,
  loadConfig,
  repoConfigPath,
  repoFromRemote,
  resolveModel,
  resolveToken,
  SpendLedger,
  selectProvider,
  supportsEffort,
  userConfigPath,
} from "@alden/core";
import type { Command } from "commander";
import { paint, shouldColor } from "../render/style.js";
import { updateNotice } from "../version.js";

const run = promisify(execFile);

export interface Finding {
  area: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** What to do about a warning or failure. */
  fix?: string;
}

const LANGUAGE_NAMES: Record<string, string> = {
  typescript: "TypeScript/JavaScript",
  tsx: "TypeScript/JavaScript",
  python: "Python",
  go: "Go",
  php: "PHP",
};

/** Which languages the code graph reads in a list of files, most files first: "TypeScript/JavaScript (812), Go (40)". */
export function graphLanguages(files: string[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = languageOf(file);
    if (!language) continue;
    const name = LANGUAGE_NAMES[language] ?? language;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .sort(([, a], [, b]) => b - a)
    .map(([name, n]) => `${name} (${n.toLocaleString("en")})`)
    .join(", ");
}

/** Everything Alden needs, checked in turn. Never throws: a check that can't run is itself a finding. */
export async function diagnose(version: string, cwd: string = process.cwd()): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  // Alden itself.
  const notice = await updateNotice(version);
  add({
    area: "Alden",
    status: notice ? "warn" : "ok",
    detail: `${version}, ${isStandaloneBinary() ? "standalone binary" : `on Node ${process.versions.node}`}`,
    ...(notice ? { fix: notice } : {}),
  });

  // Where it keeps files.
  const home = aldenHome();
  try {
    await mkdir(home, { recursive: true });
    await access(home, constants.W_OK);
    add({ area: "Files", status: "ok", detail: home });
  } catch {
    add({
      area: "Files",
      status: "fail",
      detail: `${home} isn't writable`,
      fix: "Fix its permissions, or set ALDEN_HOME to a folder you own.",
    });
  }

  // Settings.
  let config: Awaited<ReturnType<typeof loadConfig>> | undefined;
  try {
    config = await loadConfig(cwd);
    const repoConfig = repoConfigPath(cwd);
    const hasRepoConfig = await access(repoConfig).then(
      () => true,
      () => false,
    );
    add({
      area: "Settings",
      status: "ok",
      detail: `${userConfigPath()}${hasRepoConfig ? `, overridden by ${repoConfig}` : ""}`,
    });
  } catch (error) {
    add({
      area: "Settings",
      status: "fail",
      detail: (error as Error).message.slice(0, 200),
      fix: `Fix or remove the setting it names in ${userConfigPath()} or .alden.toml.`,
    });
  }

  // GitHub.
  const resolved = await resolveToken().catch(() => undefined);
  if (!resolved) {
    add({ area: "GitHub", status: "fail", detail: "not signed in", fix: "Run `alden auth login`." });
  } else {
    const from = { env: "ALDEN_GITHUB_TOKEN", alden: "Alden's stored sign-in", gh: "the GitHub CLI" }[resolved.source];
    try {
      const viewer = await getViewer(createGitHubClient(resolved.token));
      add({ area: "GitHub", status: "ok", detail: `@${viewer.login}, using ${from}` });
      if (viewer.missingScopes.length > 0) {
        add({
          area: "GitHub scopes",
          status: "warn",
          detail: `missing ${viewer.missingScopes.join(", ")}`,
          fix: viewer.missingScopes.includes("read:org")
            ? "Review requests sent to your teams won't show. Run `alden auth login --device`, or `gh auth refresh -s read:org`."
            : "Private repos won't show. Run `alden auth login --device`.",
        });
      }
    } catch {
      add({
        area: "GitHub",
        status: "fail",
        detail: `GitHub rejected the token from ${from}`,
        fix: resolved.source === "env" ? "Fix or unset ALDEN_GITHUB_TOKEN." : "Run `alden auth login --device`.",
      });
    }
  }
  if (isStandaloneBinary() && process.platform === "darwin") {
    add({
      area: "Keychain",
      status: "ok",
      detail: "macOS may ask once whether this binary can read Alden's stored sign-in; choose Always Allow",
    });
  }

  // The model.
  if (config) {
    const choice = selectProvider(config);
    const id = resolveModel(config.model.name);
    if (choice.ok) {
      const effort =
        config.model.effort && config.model.provider !== "openai-compatible" && !supportsEffort(id)
          ? ` (${id} ignores effort ${config.model.effort})`
          : config.model.effort
            ? `, effort ${config.model.effort}`
            : "";
      add({ area: "Model", status: "ok", detail: `${id} via ${config.model.provider}${effort}` });
    } else {
      add({
        area: "Model",
        status: "warn",
        detail: "none set up, so reviews run the checks only",
        fix:
          config.model.provider === "anthropic"
            ? "Set ANTHROPIC_API_KEY or run `ant auth login`; or use Bedrock, Vertex, Foundry or a local model (docs/models.md)."
            : choice.reason,
      });
    }
    const spent = await new SpendLedger().spentOn().catch(() => 0);
    add({
      area: "Budget",
      status: spent >= config.budget.dailyUsd ? "warn" : "ok",
      detail: `$${config.budget.perReviewUsd.toFixed(2)} a review, $${spent.toFixed(2)} of $${config.budget.dailyUsd.toFixed(2)} spent today`,
      ...(spent >= config.budget.dailyUsd
        ? {
            fix: "Today's cap is used up; reviews run the checks only until tomorrow. `alden config set budget.dailyUsd …` raises it.",
          }
        : {}),
    });
  }

  // This folder: a clone? Which repo? Which languages can the graph read here?
  try {
    const { stdout: root } = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
    const { stdout: remotes } = await run("git", ["remote", "-v"], { cwd });
    const repos = [...new Set(remotes.split("\n").flatMap((l) => repoFromRemote(l.split(/\s+/)[1] ?? "") ?? []))];
    const { stdout: tracked } = await run("git", ["ls-files", "-z"], {
      cwd: root.trim(),
      maxBuffer: 256 * 1024 * 1024,
    });
    const languages = graphLanguages(tracked.split("\0").filter(Boolean));
    add({
      area: "This folder",
      status: repos.length > 0 ? "ok" : "warn",
      detail: repos.length > 0 ? `a clone of ${repos.join(", ")}` : `a git repo (${root.trim()}) with no GitHub remote`,
      ...(repos.length > 0
        ? {}
        : { fix: "PR reviews find callers only from a clone of the PR's repo; add its GitHub remote." }),
    });
    add({
      area: "Code graph",
      status: languages ? "ok" : "warn",
      detail: languages ? `reads ${languages}` : "no TypeScript, JavaScript, Python, Go or PHP files here",
      ...(languages ? {} : { fix: "Callers outside the diff need one of those languages." }),
    });
  } catch {
    add({
      area: "This folder",
      status: "warn",
      detail: "not a git repo",
      fix: "Run Alden from a clone of the repo you review: that's where it finds callers and your local changes.",
    });
  }
  return findings;
}

const ICONS = { ok: "✓", warn: "!", fail: "✗" } as const;

export function renderDoctor(findings: Finding[], color: boolean): string {
  const width = Math.max(...findings.map((f) => f.area.length));
  const out = findings.map((f) => {
    const icon = paint(ICONS[f.status], f.status === "ok" ? "green" : f.status === "warn" ? "yellow" : "red", color);
    const line = `${icon} ${f.area.padEnd(width)}  ${f.detail}`;
    return f.fix ? `${line}\n${" ".repeat(width + 4)}${paint(f.fix, "dim", color)}` : line;
  });
  const problems = findings.filter((f) => f.status !== "ok").length;
  out.push(
    "",
    problems === 0
      ? "Everything Alden needs is in place."
      : `${problems} thing${problems === 1 ? "" : "s"} to look at above.`,
  );
  return `${out.join("\n")}\n`;
}

export function registerDoctorCommand(program: Command, version: string): void {
  program
    .command("doctor")
    .description("Check Alden's setup here: GitHub sign-in, the model, this clone and the code graph.")
    .option("--json", "print the findings as JSON")
    .action(async (options: { json?: boolean }) => {
      const findings = await diagnose(version);
      if (options.json) console.log(JSON.stringify(findings, null, 2));
      else process.stdout.write(renderDoctor(findings, shouldColor(process.stdout)));
      if (findings.some((f) => f.status === "fail")) process.exitCode = 1;
    });
}
