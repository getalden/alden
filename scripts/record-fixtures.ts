/**
 * Records real GitHub responses as test fixtures: `pnpm fixtures:record`.
 *
 * Public repos only. Fixtures are committed and the repo will be public, so never
 * record private repos here. Descriptions are recorded too, for the eval. PR numbers are pinned so re-recording refreshes the same PRs that
 * tests name; to add a PR, add its number.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createGitHubClient,
  PULL_REQUEST_FIELDS,
  type RawPullRequest,
  resolveToken,
} from "../packages/core/src/index.js";

const SOURCES = [
  { name: "nextjs", repo: "vercel/next.js", language: "TypeScript", numbers: [99371, 99369, 99367, 99363] },
  { name: "django", repo: "django/django", language: "Python", numbers: [22043, 22041, 22039, 22038] },
  { name: "laravel", repo: "laravel/framework", language: "PHP", numbers: [61755, 60005] },
  { name: "hugo", repo: "gohugoio/hugo", language: "Go", numbers: [15387, 15240, 15231, 15205] },
  // Grafana routes reviews to teams through CODEOWNERS, so its PRs carry team review requests.
  {
    name: "grafana",
    repo: "grafana/grafana",
    language: "Go and TypeScript",
    numbers: [133739, 133738, 133736, 133734],
  },
  // PRs a later PR had to fix (found with `pnpm regressions:find`), for the eval: did the briefing point at the code
  // that broke? Each one's expectation in eval/expectations.json names the files the fix changed.
  { name: "reg-nextjs", repo: "vercel/next.js", language: "TypeScript", numbers: [99322, 97774, 85741] },
  { name: "reg-django", repo: "django/django", language: "Python", numbers: [20538, 21239, 21420, 19057] },
  { name: "reg-cli", repo: "cli/cli", language: "Go", numbers: [13009, 14136, 10513] },
  { name: "reg-prometheus", repo: "prometheus/prometheus", language: "Go", numbers: [19183] },
  { name: "reg-laravel", repo: "laravel/framework", language: "PHP", numbers: [61099, 52242, 60720, 59404] },
];

const OUT_DIR = join(import.meta.dirname, "../packages/core/src/github/__fixtures__");

const resolved = await resolveToken();
if (!resolved) throw new Error("Not signed in. Run `alden auth login`.");
const client = createGitHubClient(resolved.token);

// `--only reg-django,reg-cli` records just those, leaving the others (and the tests that pin them) as they are.
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1]?.split(",") : undefined;

await mkdir(OUT_DIR, { recursive: true });
for (const { numbers, ...source } of SOURCES.filter((s) => !only || only.includes(s.name))) {
  const [owner, name] = source.repo.split("/");
  const fields = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { ${PULL_REQUEST_FIELDS} body }`).join("\n");
  const data = await client.graphql<{ repository: Record<string, RawPullRequest | null> }>(
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
    { owner, name },
  );
  const pullRequests = numbers.map((n) => data.repository[`p${n}`]).filter((pr): pr is RawPullRequest => pr !== null);
  const fixture = { ...source, recordedAt: new Date().toISOString(), pullRequests };
  await writeFile(join(OUT_DIR, `${source.name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);

  // Each PR's per-file patches, as GitHub's files API returns them, for the diff parser and checks.
  await mkdir(join(OUT_DIR, "diffs"), { recursive: true });
  for (const pr of pullRequests) {
    const { data } = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      owner: owner as string,
      repo: name as string,
      pull_number: pr.number,
      per_page: 100,
    });
    const files = data.map((f) => ({
      filename: f.filename,
      ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}),
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      ...(f.patch ? { patch: f.patch } : {}),
    }));
    await writeFile(join(OUT_DIR, "diffs", `${source.name}-${pr.number}.json`), `${JSON.stringify(files, null, 2)}\n`);
  }
  console.log(`${source.name}: ${pullRequests.length} PRs with diffs`);
}
