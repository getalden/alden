import { execFile } from "node:child_process";
import { access, constants, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import {
  aldenHome,
  checkOrgAccess,
  createGitHubClient,
  type GitHubClient,
  getViewer,
  githubClientId,
  isStandaloneBinary,
  languageOf,
  loadConfig,
  type OrgAccess,
  openStore,
  orgInScope,
  queueScope,
  repoConfigPath,
  repoFromRemote,
  resolveModel,
  resolveToken,
  SpendLedger,
  selectProvider,
  supportsEffort,
  type TokenSource,
  telemetryBlocked,
  telemetryConsent,
  userConfigPath,
  type Viewer,
  whyNoToken,
} from "@alden/core";
import type { Command } from "commander";
import { doctorNext, nextLine, wantsNext } from "../next.js";
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

/**
 * Whether `alden send` can post a review with this sign-in, when that can be known ahead. A classic token reports its
 * scopes: `repo` covers reviews everywhere, `public_repo` only on public repos. Fine-grained tokens and GitHub App
 * tokens don't, so for them it says what they need rather than guess.
 */
export function reviewAccess(viewer: Pick<Viewer, "scopes" | "missingScopes">): Finding {
  const area = "Sending reviews";
  if (viewer.scopes.length === 0 && viewer.missingScopes.length === 0) {
    return {
      area,
      status: "ok",
      detail:
        'can\'t be checked ahead for this kind of token: a fine-grained one needs "Pull requests: Read and write" on each repo you send to',
    };
  }
  if (viewer.scopes.includes("repo"))
    return { area, status: "ok", detail: "your sign-in can post the reviews you send" };
  return {
    area,
    status: "warn",
    detail: viewer.scopes.includes("public_repo")
      ? "your sign-in can post reviews on public repos only"
      : "your sign-in can't post reviews (it lacks the repo scope)",
    fix: "Run `alden auth login --device`, or `gh auth refresh -s repo` if Alden uses your GitHub CLI sign-in.",
  };
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

  // The local database: feedback, what was learned, memory, spending.
  try {
    const store = openStore();
    const count = (type: string) =>
      Number(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = ?", type)?.n ?? 0);
    const [feedback, opens, memory] = [count("feedback"), count("open"), count("memory")];
    add({
      area: "Database",
      status: "ok",
      detail: `${store.path} (${feedback} feedback, ${opens} opens, ${memory} memory events)`,
    });
  } catch (error) {
    add({
      area: "Database",
      status: "fail",
      detail: `couldn't open ${home}/alden.db: ${(error as Error).message.slice(0, 160)}`,
      fix: "Alden needs Node 22.13 or later (or the standalone binary). If the file is damaged, move it aside; Alden starts a new one.",
    });
  }

  // Usage stats: say plainly whether anything is sent.
  const consent = await telemetryConsent();
  const blocked = telemetryBlocked();
  add({
    area: "Usage stats",
    status: "ok",
    detail: blocked
      ? `off (${blocked})`
      : consent === "on"
        ? "on: anonymous, to PostHog EU"
        : consent === "off"
          ? "off"
          : "not asked yet; nothing is sent until you say yes",
  });

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
    const problem = await whyNoToken();
    add(
      problem.kind === "keychain"
        ? {
            area: "GitHub",
            status: "fail",
            detail: `couldn't read the keychain (${problem.detail})`,
            fix: "Allow Alden when macOS asks, or run `alden auth login` again. An unsigned development build of Alden.app can't read the keychain: open the installed app instead.",
          }
        : { area: "GitHub", status: "fail", detail: "not signed in", fix: "Run `alden auth login`." },
    );
  } else {
    const from = { env: "ALDEN_GITHUB_TOKEN", alden: "Alden's stored sign-in", gh: "the GitHub CLI" }[resolved.source];
    try {
      const client = createGitHubClient(resolved.token);
      const viewer = await getViewer(client);
      add({ area: "GitHub", status: "ok", detail: `@${viewer.login}, using ${from}` });
      const scope = config ? queueScope(config) : { repos: [], orgs: [], ignore: [] };
      if (scope.orgs.length || scope.repos.length || scope.ignore.length) {
        const parts = [
          scope.orgs.length || scope.repos.length ? `only ${[...scope.orgs, ...scope.repos].join(", ")}` : "",
          scope.ignore.length ? `leaving out ${scope.ignore.join(", ")}` : "",
        ].filter(Boolean);
        add({ area: "Queue", status: "ok", detail: `${parts.join("; ")} (queue.orgs, queue.repos, queue.ignore)` });
      }
      for (const line of await orgLines(client, resolved.source, scope)) add(line);
      add(reviewAccess(viewer));
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
        fix:
          resolved.source === "env"
            ? "Fix or unset ALDEN_GITHUB_TOKEN."
            : resolved.source === "alden"
              ? "Run `alden auth login --device` to sign in again, or `alden auth logout` to use your GitHub CLI sign-in."
              : "Run `gh auth login` to refresh it, or `alden auth login --device` to sign in to Alden directly.",
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
    const choice = await selectProvider(config);
    const id = resolveModel(config.model.name);
    if (choice.ok) {
      const effort =
        config.model.effort && config.model.provider !== "openai-compatible" && !supportsEffort(id)
          ? ` (${id} ignores effort ${config.model.effort})`
          : config.model.effort
            ? `, effort ${config.model.effort}`
            : "";
      const key = choice.key ? `, using ${choice.key.where}` : "";
      add({ area: "Model", status: "ok", detail: `${id} via ${config.model.provider}${effort}${key}` });
    } else {
      add({
        area: "Model",
        status: "warn",
        detail: "none set up, so reviews run the checks only",
        fix:
          config.model.provider === "anthropic"
            ? "Run `alden setup` to paste an API key or use a local model (or set ANTHROPIC_API_KEY); Bedrock, Vertex and Foundry are in docs/models.md."
            : `${choice.reason} Or run \`alden setup\`.`,
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
      if (wantsNext(options.json)) {
        const width = Math.min(process.stdout.columns ?? 100, 120);
        process.stdout.write(nextLine(doctorNext(findings), { width, color: shouldColor(process.stdout) }));
      }
      if (findings.some((f) => f.status === "fail")) process.exitCode = 1;
    });
}

/** Alden's OAuth app's page in the user's GitHub settings, where they authorize it for SSO or request approval. */
function aldenAppSettings(): string {
  try {
    return `https://github.com/settings/connections/applications/${githubClientId()}`;
  } catch {
    return "https://github.com/settings/applications";
  }
}

/** One line for the orgs this sign-in can see, and one per org that hides its PRs, with the fix for this sign-in. */
async function orgLines(
  client: GitHubClient,
  source: TokenSource,
  scope: { orgs: string[]; repos: string[]; ignore: string[] },
): Promise<Finding[]> {
  let access: OrgAccess[];
  try {
    // Only the orgs this machine's queue covers: a work org's sign-on is no concern on a personal laptop.
    access = (await checkOrgAccess(client)).filter((a) => orgInScope(a.org, scope));
  } catch {
    return [];
  }
  const scoped = scope.orgs.length + scope.repos.length > 0;
  const blocked = access.filter((a) => a.access === "sso" || a.access === "restricted");
  const visible = access.filter((a) => a.access === "ok").map((a) => a.org);
  const lines: Finding[] = [];
  if (access.length > 0) {
    lines.push({
      area: "Organizations",
      status: blocked.length ? "warn" : "ok",
      detail: `${
        visible.length ? `can see PRs in ${visible.join(", ")}` : "can't see private PRs in any of your organizations"
      }${
        // Without the GitHub CLI to compare with, an org that hides itself from this sign-in may not show up at all.
        blocked.length === 0 && source !== "gh" && !scoped
          ? " (company missing? see getalden.dev/docs/troubleshooting)"
          : ""
      }`,
    });
  }
  for (const { org, access: state } of blocked) {
    const fix =
      state === "sso"
        ? source === "alden"
          ? `Open ${aldenAppSettings()} and click Authorize next to ${org} (it signs you in to ${org}'s single sign-on).`
          : source === "gh"
            ? `Run \`gh auth refresh -h github.com\` and authorize ${org} in the browser, or authorize the GitHub CLI for it at https://github.com/settings/applications.`
            : `At https://github.com/settings/tokens, choose Configure SSO next to the token and authorize ${org}.`
        : source === "alden"
          ? `Ask a ${org} owner to approve Alden (click Request next to ${org} at ${aldenAppSettings()}). Meanwhile, \`alden auth logout\` switches to your GitHub CLI sign-in, if ${org} approved that.`
          : source === "gh"
            ? `${org} hasn't approved the GitHub CLI either. Use a classic personal access token (\`alden auth login --with-token\`), or ask an owner to approve Alden.`
            : `Ask a ${org} owner to approve the token's access, or use a classic personal access token.`;
    lines.push({
      area: `Org ${org}`,
      status: "warn",
      detail:
        state === "sso"
          ? "uses single sign-on, and this sign-in isn't authorized for it: its PRs are missing from your queue"
          : "restricts third-party apps and hasn't approved this sign-in: its private PRs are missing from your queue",
      fix,
    });
  }
  return lines;
}
