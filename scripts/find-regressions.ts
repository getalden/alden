/**
 * Finds PRs that a later PR had to fix, for the eval: `pnpm regressions:find <owner/repo> [--limit 60]`.
 *
 * Searches merged PRs that mention a regression, follows their references back (#123, PR links, and commit SHAs,
 * which is how Django refers to them) to the PR that caused it, and keeps pairs where the fix changed code files the
 * original changed. Those files are what a good briefing on the original should have pointed at. Prints candidates;
 * a person picks which to record (see record-fixtures.ts and eval/expectations.json).
 */
import { createGitHubClient, fileKind, resolveToken } from "../packages/core/src/index.js";

const args = process.argv.slice(2);
const repo = args.find((a) => /^[\w.-]+\/[\w.-]+$/.test(a));
if (!repo) throw new Error("Usage: pnpm regressions:find owner/repo [--limit 60]");
const limit = Number(args[args.indexOf("--limit") + 1] ?? 60) || 60;
const [owner, name] = repo.split("/") as [string, string];

const resolved = await resolveToken();
if (!resolved) throw new Error("Not signed in. Run `alden auth login`.");
const client = createGitHubClient(resolved.token);

interface Pr {
  number: number;
  title: string;
  body: string;
  mergedAt: string | null;
  files: string[];
}

const PR_FIELDS = "number title body mergedAt files(first: 100) { nodes { path } }";
type RawPr = Omit<Pr, "files"> & { files: { nodes: { path: string }[] } | null };
const toPr = (raw: RawPr): Pr => ({ ...raw, files: raw.files?.nodes.map((n) => n.path) ?? [] });

async function searchFixes(): Promise<Pr[]> {
  const out: Pr[] = [];
  let after: string | null = null;
  while (out.length < limit) {
    const data: {
      search: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: (RawPr | Record<string, never>)[];
      };
    } = await client.graphql(
      `query($q: String!, $first: Int!, $after: String) {
        search(query: $q, type: ISSUE, first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { ... on PullRequest { ${PR_FIELDS} } }
        }
      }`,
      { q: `repo:${repo} is:pr is:merged regression in:title,body sort:updated-desc`, first: 25, after },
    );
    out.push(...data.search.nodes.filter((n): n is RawPr => "number" in n).map(toPr));
    if (!data.search.pageInfo.hasNextPage) break;
    after = data.search.pageInfo.endCursor;
  }
  return out.slice(0, limit);
}

async function pullRequest(number: number): Promise<Pr | undefined> {
  try {
    const data = await client.graphql<{ repository: { pullRequest: RawPr | null } }>(
      `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) { ${PR_FIELDS} } } }`,
      { owner, name, n: number },
    );
    return data.repository.pullRequest ? toPr(data.repository.pullRequest) : undefined;
  } catch {
    return undefined;
  }
}

/** The PRs a commit came from. */
async function pullsForCommit(sha: string): Promise<number[]> {
  try {
    const { data } = await client.request("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", {
      owner,
      repo: name,
      commit_sha: sha,
    });
    return data.filter((p) => p.merged_at).map((p) => p.number);
  } catch {
    return [];
  }
}

/** Where a fix says the regression came from. */
async function referencedPrs(fix: Pr): Promise<number[]> {
  const text = `${fix.title}\n${fix.body}`;
  const numbers = new Set<number>();
  for (const m of text.matchAll(new RegExp(`github\\.com/${owner}/${name}/pull/(\\d+)`, "gi")))
    numbers.add(Number(m[1]));
  // "#123" near "regression", "introduced", "caused", "revert" or "from".
  for (const m of text.matchAll(
    /(?:regression|introduced|caused|reverts?|from|since|in)\s+(?:by\s+|in\s+|from\s+)?#(\d+)/gi,
  )) {
    numbers.add(Number(m[1]));
  }
  for (const m of text.matchAll(/(?:regression|introduced|caused)\s+(?:in|by)\s+([0-9a-f]{7,40})\b/gi)) {
    for (const n of await pullsForCommit(m[1] as string)) numbers.add(n);
  }
  numbers.delete(fix.number);
  return [...numbers].slice(0, 4);
}

const code = (path: string) => fileKind(path) === "code";
const fixes = await searchFixes();
const candidates: { original: number; title: string; fix: number; fixTitle: string; overlap: string[] }[] = [];
for (const fix of fixes) {
  for (const n of await referencedPrs(fix)) {
    const original = await pullRequest(n);
    if (!original?.mergedAt || !fix.mergedAt || original.mergedAt >= fix.mergedAt) continue;
    const overlap = original.files.filter((f) => code(f) && fix.files.includes(f));
    if (overlap.length === 0 || original.files.length > 60) continue;
    candidates.push({ original: n, title: original.title, fix: fix.number, fixTitle: fix.title, overlap });
  }
}
console.log(JSON.stringify({ repo, searched: fixes.length, candidates }, null, 2));
