/**
 * Records real GitHub responses as test fixtures: `pnpm fixtures:record`.
 *
 * Public repos only, one per supported language. Fixtures are committed and the repo will be public, so never
 * record private repos (your own included) here. PR numbers are pinned so re-recording refreshes the same PRs that
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
];

const OUT_DIR = join(import.meta.dirname, "../packages/core/src/github/__fixtures__");

const resolved = await resolveToken();
if (!resolved) throw new Error("Not signed in. Run `alden auth login`.");
const client = createGitHubClient(resolved.token);

await mkdir(OUT_DIR, { recursive: true });
for (const { numbers, ...source } of SOURCES) {
  const [owner, name] = source.repo.split("/");
  const fields = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { ${PULL_REQUEST_FIELDS} }`).join("\n");
  const data = await client.graphql<{ repository: Record<string, RawPullRequest | null> }>(
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
    { owner, name },
  );
  const pullRequests = numbers.map((n) => data.repository[`p${n}`]).filter((pr): pr is RawPullRequest => pr !== null);
  const fixture = { ...source, recordedAt: new Date().toISOString(), pullRequests };
  await writeFile(join(OUT_DIR, `${source.name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${source.name}: ${pullRequests.length} PRs`);
}
