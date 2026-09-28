/**
 * Records real GitHub responses as test fixtures: `pnpm fixtures:record`.
 *
 * Public repos only, one per supported language. Fixtures are committed and the repo will be public, so never
 * record private repos (your own included) here.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGitHubClient, resolveToken, searchPullRequests } from "../packages/core/src/index.js";

const SOURCES = [
  { name: "nextjs", repo: "vercel/next.js", language: "TypeScript" },
  { name: "django", repo: "django/django", language: "Python" },
  { name: "laravel", repo: "laravel/framework", language: "PHP" },
  { name: "hugo", repo: "gohugoio/hugo", language: "Go" },
  // Grafana routes reviews to teams through CODEOWNERS, so its PRs carry team review requests.
  { name: "grafana", repo: "grafana/grafana", language: "Go and TypeScript" },
];

const PER_REPO = 4;
const OUT_DIR = join(import.meta.dirname, "../packages/core/src/github/__fixtures__");

const resolved = await resolveToken();
if (!resolved) throw new Error("Not signed in. Run `alden auth login`.");
const client = createGitHubClient(resolved.token);

await mkdir(OUT_DIR, { recursive: true });
for (const source of SOURCES) {
  const query = `repo:${source.repo} is:pr is:open draft:false`;
  const pullRequests = await searchPullRequests(client, query, PER_REPO);
  const fixture = { ...source, query, recordedAt: new Date().toISOString(), pullRequests };
  await writeFile(join(OUT_DIR, `${source.name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${source.name}: ${pullRequests.length} PRs`);
}
