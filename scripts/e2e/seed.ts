/**
 * Opens Alden's end-to-end test PRs in a repo, from a second GitHub account, with your review requested:
 *
 *   pnpm e2e:seed --repo owner/name --clone <path> [--base alden-e2e] [--from main] [--reviewer you] [--team org/slug]
 *   pnpm e2e:seed --repo owner/name --clone <path> --dry-run      # what it would open, touching nothing
 *   … --avoid 'skills/**,sdks/**'                                  # paths no PR may touch (e.g. ones that start CI)
 *   pnpm e2e:seed --repo owner/name --clone <path> --cleanup      # close them and delete their branches
 *
 * Alden's queue is "PRs waiting on your review", and GitHub won't let you request your own review, so the PRs come
 * from another account: ALDEN_E2E_AUTHOR_TOKEN is that account's classic token (scopes: repo, workflow), and it needs
 * write access to the repo (a collaborator, or a member of the org). Its pushes and PRs never use your own sign-in.
 *
 * PRs go to a base branch of their own (`alden-e2e`, made from --from), so the repo's CI, which usually runs only for
 * PRs to main, stays quiet and main never sees them. Branches are made in a temporary worktree of --clone, so your
 * working copy isn't touched. The list of PRs and what Alden should do with each is written to eval/e2e/, for
 * `pnpm e2e:verify`.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openRepo, type Planned, plan } from "./scenarios.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const repoArg = option("repo");
const cloneArg = option("clone");
if (!repoArg || !/^[\w.-]+\/[\w.-]+$/.test(repoArg) || !cloneArg) {
  throw new Error(
    "Usage: pnpm e2e:seed --repo owner/name --clone <path> [--dry-run | --cleanup] (see the file header)",
  );
}
const repo: string = repoArg;
const clone: string = cloneArg;
const base = option("base") ?? "alden-e2e";
const dryRun = flag("dry-run");
const only = option("only")?.split(",");
const ROOT = join(import.meta.dirname, "../..");
const manifestPath = join(ROOT, "eval/e2e", `${repo.replace("/", "__")}.json`);

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", maxBuffer: 1 << 28 }).trim();

const token = process.env.ALDEN_E2E_AUTHOR_TOKEN;
async function gh<T>(
  method: string,
  path: string,
  body?: unknown,
  ok: number[] = [],
  as: string | undefined = token,
): Promise<T | undefined> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${as}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "alden-e2e",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (ok.includes(res.status)) return undefined;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? undefined : ((await res.json()) as T);
}

/** Pushes with the author account's token and nothing else: your keychain and credential helper stay out of it. */
function pushAs(cwd: string, ...refspecs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "alden-e2e-askpass-"));
  const askpass = join(dir, "askpass.sh");
  writeFileSync(askpass, '#!/bin/sh\nprintf "%s" "$ALDEN_E2E_AUTHOR_TOKEN"\n');
  chmodSync(askpass, 0o700);
  try {
    execFileSync(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "credential.helper=",
        "push",
        "--force",
        "--quiet",
        `https://alden-e2e@github.com/${repo}.git`,
        ...refspecs,
      ],
      { env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer }).stderr ?? "").trim();
    throw new Error(`git push failed: ${stderr.split("\n").at(-2) ?? stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Your own GitHub CLI token, for the few calls only an org member can make. */
let yours: string | undefined;
const yourToken = () => (yours ??= execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Cleanup ───
if (flag("cleanup")) {
  if (!token) throw new Error("Set ALDEN_E2E_AUTHOR_TOKEN (the author account's token).");
  let closed = 0;
  for (let page = 1; ; page++) {
    const prs =
      (await gh<{ number: number; head: { ref: string } }[]>(
        "GET",
        `/repos/${repo}/pulls?state=open&per_page=100&page=${page}`,
      )) ?? [];
    for (const pr of prs.filter((p) => p.head.ref.startsWith("alden-e2e-pr/"))) {
      await gh("PATCH", `/repos/${repo}/pulls/${pr.number}`, { state: "closed" });
      await gh("DELETE", `/repos/${repo}/git/refs/heads/${pr.head.ref}`, undefined, [422, 404]);
      closed++;
    }
    if (prs.length < 100) break;
  }
  if (flag("all")) await gh("DELETE", `/repos/${repo}/git/refs/heads/${base}`, undefined, [422, 404]);
  rmSync(manifestPath, { force: true });
  console.log(`Closed ${closed} test PRs in ${repo} and deleted their branches${flag("all") ? `, and ${base}` : ""}.`);
  process.exit(0);
}

// ─── Plan ───
git(clone, "fetch", "--quiet", "origin");
const from = option("from") ?? git(clone, "rev-parse", "--abbrev-ref", "origin/HEAD").replace(/^origin\//, "");
const work = mkdtempSync(join(tmpdir(), "alden-e2e-"));
git(clone, "worktree", "add", "--detach", "--quiet", work, `origin/${from}`);
try {
  const planned = plan(openRepo(work, option("avoid")?.split(",") ?? [])).filter((p) => !only || only.includes(p.id));
  console.log(`${planned.length} test PRs for ${repo} (base ${base}, made from ${from}):`);
  for (const p of planned) {
    const extra = [
      p.draft && "draft",
      p.stackOn && `on ${p.stackOn}`,
      p.conflictWith && "conflicts",
      p.team && "team",
    ].filter(Boolean);
    console.log(
      `  ${p.id.padEnd(26)} ${p.expect.lane.padEnd(24)} ${p.expect.flags.join(", ") || "—"}${extra.length ? `  (${extra.join(", ")})` : ""}`,
    );
    console.log(`  ${"".padEnd(26)} ${p.edits.map((e) => e.path).join(", ")}`);
  }
  if (!dryRun) await seed(planned);
} finally {
  git(clone, "worktree", "remove", "--force", work);
}

async function seed(planned: Planned[]): Promise<void> {
  if (!token)
    throw new Error("Set ALDEN_E2E_AUTHOR_TOKEN (the author account's classic token, scopes repo and workflow).");

  const author = await gh<{ login: string; id: number }>("GET", "/user");
  if (!author) throw new Error("Couldn't read the author account.");
  const reviewer =
    option("reviewer") ?? execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8" }).trim();
  // --no-request tests the kit itself: PRs from your own account, with no review requested (they won't be in a queue).
  const noRequest = flag("no-request");
  if (!noRequest && reviewer.toLowerCase() === author.login.toLowerCase()) {
    throw new Error(
      "ALDEN_E2E_AUTHOR_TOKEN is your own account's: the PRs need another author to request your review.",
    );
  }
  const team = option("team");
  const identity = [
    "-c",
    `user.name=${author.login}`,
    "-c",
    `user.email=${author.id}+${author.login}@users.noreply.github.com`,
  ];

  // The base branch, unless it's already there (a second run reuses it).
  const exists = await gh("GET", `/repos/${repo}/branches/${base}`, undefined, [404]);
  if (!exists) pushAs(work, `refs/remotes/origin/${from}:refs/heads/${base}`);

  /** Asks for your review: a team with your own sign-in (the test account, an outside collaborator, can't see
   * org teams), you by name from the test account. Asking again is harmless. */
  const requestReview = async (number: number, p: Planned) => {
    if (noRequest) return;
    const viaTeam = p.team && team;
    await gh(
      "POST",
      `/repos/${repo}/pulls/${number}/requested_reviewers`,
      viaTeam ? { team_reviewers: [(team as string).split("/")[1]] } : { reviewers: [reviewer] },
      [],
      viaTeam ? yourToken() : token,
    );
  };

  const opened: { id: string; number: number; url: string; title: string; expect: Planned["expect"] }[] = [];
  const branchOf = (id: string) => `alden-e2e-pr/${id}`;
  for (const p of planned) {
    // A re-run (after a rate limit, say) skips PRs that are already open, unless --only names them.
    const [already] =
      (await gh<{ number: number; html_url: string }[]>(
        "GET",
        `/repos/${repo}/pulls?head=${repo.split("/")[0]}:${branchOf(p.id)}&state=open`,
      )) ?? [];
    if (already && !only) {
      await requestReview(already.number, p); // in case the earlier run stopped before asking
      opened.push({ id: p.id, number: already.number, url: already.html_url, title: p.title, expect: p.expect });
      console.log(`already open #${already.number}  ${p.id}`);
      continue;
    }
    // A stack's parent may come from an earlier run: then it's only on GitHub.
    const stackParent = p.stackOn ? branchOf(p.stackOn) : undefined;
    if (stackParent && !git(work, "branch", "--list", stackParent)) {
      git(work, "fetch", "--quiet", `https://github.com/${repo}.git`, `${stackParent}:${stackParent}`);
    }
    const parent = stackParent ?? `origin/${from}`;
    git(work, "checkout", "--quiet", "--force", "-B", branchOf(p.id), parent);
    for (const edit of p.edits) {
      const path = join(work, edit.path);
      if (edit.from) git(work, "mv", edit.from, edit.path);
      if (edit.content === null) git(work, "rm", "--quiet", edit.path);
      else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, edit.content);
      }
    }
    git(work, "add", "-A");
    execFileSync("git", ["-C", work, ...identity, "commit", "--quiet", "--no-verify", "-m", p.title], {
      stdio: "ignore",
    });
    pushAs(work, `${branchOf(p.id)}:refs/heads/${branchOf(p.id)}`);

    const headBase = p.stackOn ? branchOf(p.stackOn) : base;
    const open = (draft: boolean, title: string) =>
      gh<{ number: number; html_url: string }>(
        "POST",
        `/repos/${repo}/pulls`,
        { title, head: branchOf(p.id), base: headBase, body: p.body, draft },
        [422],
      );
    let pr = await open(p.draft ?? false, p.title);
    // Private repos on GitHub's free plans can't have drafts: open it as a normal PR, marked in the title.
    if (!pr && p.draft) pr = await open(false, `[Draft] ${p.title}`);
    if (!pr) {
      // Already open from an earlier run.
      const [existing] =
        (await gh<{ number: number; html_url: string }[]>(
          "GET",
          `/repos/${repo}/pulls?head=${repo.split("/")[0]}:${branchOf(p.id)}&state=open`,
        )) ?? [];
      if (!existing) throw new Error(`Couldn't open or find the PR for ${p.id}.`);
      pr = existing;
    }
    for (const label of p.labels ?? []) {
      await gh("POST", `/repos/${repo}/labels`, { name: label, color: "ededed" }, [422]);
    }
    if (p.labels?.length) await gh("POST", `/repos/${repo}/issues/${pr.number}/labels`, { labels: p.labels });
    await requestReview(pr.number, p);

    opened.push({ id: p.id, number: pr.number, url: pr.html_url, title: p.title, expect: p.expect });
    console.log(`opened #${pr.number}  ${p.id}`);
    await sleep(3_000); // GitHub limits how fast one account can create content (about 80 a minute, 500 an hour).
  }

  // Conflicts last, so the base changes only after every PR is open: a file each conflicting PR adds lands on the base
  // with other content.
  const conflicts = planned.filter((p) => p.conflictWith && p.edits[0]);
  if (conflicts.length) {
    git(work, "fetch", "--quiet", "origin");
    git(work, "checkout", "--quiet", "--force", "-B", "alden-e2e-base", `origin/${base}`);
    for (const p of conflicts) {
      const path = join(work, (p.edits[0] as { path: string }).path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, p.conflictWith as string);
    }
    git(work, "add", "-A");
    execFileSync(
      "git",
      ["-C", work, ...identity, "commit", "--quiet", "--no-verify", "-m", "Set the retry limit on the base"],
      { stdio: "ignore" },
    );
    pushAs(work, `alden-e2e-base:refs/heads/${base}`);
    console.log(`changed ${base} so ${conflicts.map((p) => p.id).join(", ")} conflict`);
  }

  // A run with --only adds to (or refreshes) the PRs an earlier run wrote down, rather than replacing them.
  mkdirSync(dirname(manifestPath), { recursive: true });
  const earlier = existsSync(manifestPath)
    ? ((JSON.parse(readFileSync(manifestPath, "utf8")) as { prs: typeof opened }).prs ?? [])
    : [];
  const prs = [...earlier.filter((e) => !opened.some((o) => o.id === e.id)), ...opened];
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ repo, base, from, author: author.login, reviewer, team: team ?? null, updatedAt: new Date().toISOString(), prs }, null, 2)}\n`,
  );
  console.log(
    `\n${opened.length} PRs open in ${repo}, ${noRequest ? "no review requested (--no-request)" : `review requested from ${reviewer}`}. Expectations: ${manifestPath}`,
  );
  console.log(`Check Alden against them: pnpm e2e:verify --repo ${repo} --clone ${clone}`);
}
