import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCodeowners } from "./codeowners.js";
import { type RawPullRequest, toFacts, type Viewer } from "./pull-requests.js";

interface Fixture {
  name: string;
  pullRequests: RawPullRequest[];
}

const FIXTURE_DIR = join(import.meta.dirname, "__fixtures__");
const fixtures: Fixture[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as Fixture);

function pr(fixture: string, number: number): RawPullRequest {
  const found = fixtures.find((f) => f.name === fixture)?.pullRequests.find((p) => p.number === number);
  if (!found) throw new Error(`No fixture PR ${fixture}#${number}`);
  return structuredClone(found);
}

const outsider: Viewer = { login: "someone-else", teams: new Set() };

describe("toFacts on every recorded PR", () => {
  const all = fixtures.flatMap((f) => f.pullRequests.map((p) => [`${f.name}#${p.number}`, p] as const));

  it.each(all)("%s maps cleanly", (_label, raw) => {
    const facts = toFacts(raw, outsider);
    expect(facts.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(["success", "failure", "pending", "none"]).toContain(facts.ci);
    expect(["mergeable", "conflicting", "unknown"]).toContain(facts.mergeable);
    expect(facts.request).toEqual({ direct: false, teams: [], requestedAt: null });
    if (!facts.filesTruncated) expect(facts.files).toHaveLength(facts.changedFiles);
  });

  it("covers all four phase 1 languages", () => {
    expect(fixtures.map((f) => f.name)).toEqual(expect.arrayContaining(["nextjs", "django", "laravel", "hugo"]));
  });
});

describe("toFacts", () => {
  it("maps CI rollups", () => {
    expect(toFacts(pr("django", 22043), outsider).ci).toBe("failure");
    expect(toFacts(pr("nextjs", 99371), outsider).ci).toBe("pending");
    expect(toFacts(pr("hugo", 15387), outsider).ci).toBe("success");
  });

  it("spots a direct request and when it was made, ignoring login case", () => {
    const facts = toFacts(pr("grafana", 133736), { login: "nwrichmond", teams: new Set() });
    expect(facts.request.direct).toBe(true);
    expect(facts.request.teams).toEqual([]);
    expect(facts.request.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("skips reviewers GitHub hides (null), such as teams in orgs the viewer isn't in", () => {
    const facts = toFacts(pr("grafana", 133734), { login: "joshhunt", teams: new Set() });
    expect(facts.request.direct).toBe(true);
    expect(facts.request.requestedAt).toBe("2026-09-28T17:05:46Z");
  });

  it("spots a request sent to one of the viewer's teams", () => {
    const raw = pr("grafana", 133734);
    const team = { __typename: "Team" as const, slug: "Frontend-Ops", organization: { login: "grafana" } };
    raw.reviewRequests.nodes[0] = { requestedReviewer: team };
    raw.timelineItems.nodes[0] = { createdAt: "2026-09-28T16:42:10Z", requestedReviewer: team };

    const facts = toFacts(raw, { login: "member", teams: new Set(["grafana/frontend-ops"]) });
    expect(facts.request).toEqual({
      direct: false,
      teams: ["grafana/frontend-ops"],
      requestedAt: "2026-09-28T16:42:10Z",
    });
  });

  it("marks PRs with more files than Alden fetched", () => {
    const raw = pr("laravel", 60005);
    expect(toFacts(raw, outsider).filesTruncated).toBe(false);
    raw.files = { nodes: raw.files?.nodes ?? [], pageInfo: { hasNextPage: true } };
    expect(toFacts(raw, outsider).filesTruncated).toBe(true);
  });

  it("lists the changed files the viewer owns through CODEOWNERS", () => {
    const raw = pr("laravel", 60005);
    const paths = (raw.files?.nodes ?? []).map((f) => f.path);
    const firstDir = paths[0]?.split("/")[0];
    const rules = parseCodeowners(`* @laravel/core\n/${firstDir}/ @member\n`);

    const facts = toFacts(raw, { login: "member", teams: new Set() }, rules);
    expect(facts.codeownedFiles.length).toBeGreaterThan(0);
    expect(facts.codeownedFiles.every((p) => p.startsWith(`${firstDir}/`))).toBe(true);

    const viaTeam = toFacts(raw, { login: "other", teams: new Set(["laravel/core"]) }, rules);
    expect(viaTeam.codeownedFiles).toEqual(paths.filter((p) => !p.startsWith(`${firstDir}/`)));
  });
});
