/**
 * Checks Alden against the test PRs `pnpm e2e:seed` opened: `pnpm e2e:verify --repo owner/name --clone <path>`.
 *
 * Signed in as you (the reviewer), it ranks your queue for the repo and briefs each test PR with the checks and the
 * code graph (no model, so it's free), then compares the lane, the queue's reasons and the flagged checks with what
 * each scenario expects (eval/e2e/<repo>.json). What a script can't judge is listed as "look" for you to check by
 * hand. Results go to eval/e2e/<repo>.results.json; it exits non-zero on any failure.
 *
 * It ranks without your learned preferences, so results don't depend on what you've taught Alden; learning has its
 * own steps in the test session.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createGitHubClient,
  fetchReviewQueue,
  loadConfig,
  rankQueue,
  resolveToken,
  reviewPullRequest,
} from "../../packages/core/src/index.js";
import type { RankedPullRequest } from "../../packages/schema/src/index.js";
import type { Expect } from "./scenarios.js";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const repo = option("repo");
const clone = option("clone");
if (!repo || !clone) throw new Error("Usage: pnpm e2e:verify --repo owner/name --clone <path> [--only id,id]");
const only = option("only")?.split(",");

const ROOT = join(import.meta.dirname, "../..");
const base = join(ROOT, "eval/e2e", repo.replace("/", "__"));
const manifest = JSON.parse(readFileSync(`${base}.json`, "utf8")) as {
  prs: { id: string; number: number; url: string; title: string; expect: Expect }[];
};

const resolved = await resolveToken();
if (!resolved) throw new Error("Not signed in. Run `alden auth login` first: verify runs as you, the reviewer.");
const client = createGitHubClient(resolved.token);
const config = await loadConfig(clone);
const queue = await fetchReviewQueue(client, { repos: [repo], limit: 100, refresh: true });
const ranked = rankQueue(queue, config.queue, Date.now(), () => undefined);
const rows = new Map<number, { lane: string; rank: number; row: RankedPullRequest }>();
for (const [lane, list] of [
  ["needs-you", ranked.needsYou],
  ["fast-track", ranked.fastTrack],
] as const) {
  list.forEach((row, i) => {
    rows.set(row.pr.number, { lane, rank: i + 1, row });
  });
}

interface Result {
  id: string;
  number: number;
  url: string;
  pass: boolean;
  problems: string[];
  look?: string;
  lane: string;
  rank: number | null;
  flagged: string[];
  reasons: string[];
}
const results: Result[] = [];

for (const pr of manifest.prs.filter((p) => !only || only.includes(p.id))) {
  const problems: string[] = [];
  const inQueue = rows.get(pr.number);
  // Drafts stay out of the queue unless queue.includeDrafts is on.
  const lane = inQueue?.lane ?? (pr.id === "draft" && !config.queue.includeDrafts ? "hidden" : "missing");
  const reasons = inQueue?.row.reasons ?? [];
  const ci = inQueue?.row.pr.ci;

  const want = pr.expect.lane;
  if (want === "fast-track" && lane !== "fast-track") problems.push(`lane is ${lane}, not fast-track`);
  if (want === "needs-you" && lane !== "needs-you") problems.push(`lane is ${lane}, not needs-you`);
  if (want === "fast-track if CI passes") {
    if (ci === "success" && lane !== "fast-track") problems.push(`CI passed but the lane is ${lane}`);
    if (ci !== "success" && lane === "fast-track") problems.push(`fast-tracked without green CI (${ci})`);
  }
  if (lane === "missing") problems.push("not in your queue (is your review requested?)");
  for (const words of pr.expect.reasons ?? []) {
    if (inQueue && !reasons.some((r) => r.toLowerCase().includes(words.toLowerCase()))) {
      problems.push(`no reason mentioning "${words}" (has: ${reasons.join("; ") || "none"})`);
    }
  }

  let flagged: string[] = [];
  try {
    const briefing = await reviewPullRequest(client, repo, pr.number, config, undefined, { enabled: true, cwd: clone });
    flagged = briefing.checks.filter((c) => c.status === "flagged").map((c) => c.id);
    for (const id of pr.expect.flags) if (!flagged.includes(id)) problems.push(`${id} not flagged`);
    for (const id of pr.expect.quiet ?? []) if (flagged.includes(id)) problems.push(`${id} flagged but shouldn't be`);
  } catch (error) {
    problems.push(`briefing failed: ${(error as Error).message.slice(0, 160)}`);
  }

  const result: Result = {
    id: pr.id,
    number: pr.number,
    url: pr.url,
    pass: problems.length === 0,
    problems,
    lane,
    rank: inQueue?.rank ?? null,
    flagged,
    reasons,
    ...(pr.expect.manual ? { look: pr.expect.manual } : {}),
  };
  results.push(result);
  console.log(
    `${result.pass ? "ok  " : "FAIL"} #${String(pr.number).padEnd(5)} ${pr.id.padEnd(26)} ${lane.padEnd(10)} ${problems.join("; ")}`,
  );
}

writeFileSync(`${base}.results.json`, `${JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)}\n`);
const failed = results.filter((r) => !r.pass);
const looks = results.filter((r) => r.look);
console.log(
  `\n${results.length - failed.length} of ${results.length} as expected. ${looks.length} things to look at by hand:`,
);
for (const r of looks) console.log(`  #${r.number} ${r.id}: ${r.look}`);
console.log(`\nDetails: ${base}.results.json`);
process.exit(failed.length ? 1 : 0);
