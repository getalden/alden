import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCodeowners } from "./codeowners.js";
import { PULL_REQUEST_FIELDS, type RawPullRequest, toFacts, type Viewer } from "./pull-requests.js";

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
  it("reads assignees, and none from a fixture recorded before Alden asked for them", () => {
    const raw = pr("hugo", 15387);
    expect(toFacts(raw, outsider).assignees).toEqual([]);
    raw.assignees = { nodes: [{ login: "bep" }, { login: "jmooring" }] };
    expect(toFacts(raw, outsider).assignees).toEqual(["bep", "jmooring"]);
    // One small connection on the details already fetched: no extra request.
    expect(PULL_REQUEST_FIELDS).toContain("assignees(first: 10) { nodes { login } }");
  });

  it("reads the commit each review was on, and none from a fixture recorded before Alden asked for it", () => {
    const raw = pr("hugo", 15387);
    raw.reviews = {
      nodes: [
        { author: { login: "bep" }, state: "COMMENTED", submittedAt: "2026-09-01T10:00:00Z" },
        { author: { login: "bep" }, state: "APPROVED", submittedAt: "2026-09-02T10:00:00Z", commit: { oid: "abc123" } },
        { author: { login: "bep" }, state: "DISMISSED", submittedAt: "2026-09-03T10:00:00Z", commit: null },
      ],
    };
    const reviews = toFacts(raw, outsider).reviews;
    expect(reviews.map((r) => r.commit)).toEqual([undefined, "abc123", undefined]);
    expect(reviews[0]).not.toHaveProperty("commit");
    expect(PULL_REQUEST_FIELDS).toContain(
      "reviews(last: 20) { nodes { author { login } state submittedAt commit { oid } } }",
    );
  });

  it("maps CI rollups", () => {
    // Real CI results change between recordings, so set each rollup explicitly.
    const withRollup = (state: string | null) => {
      const raw = pr("hugo", 15387);
      raw.commits = { nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }] };
      return toFacts(raw, outsider).ci;
    };
    expect(withRollup("SUCCESS")).toBe("success");
    expect(withRollup("FAILURE")).toBe("failure");
    expect(withRollup("ERROR")).toBe("failure");
    expect(withRollup("PENDING")).toBe("pending");
    expect(withRollup("EXPECTED")).toBe("pending");
    expect(withRollup(null)).toBe("none");
  });

  it("doesn't call CI failing when the only runs that didn't pass were cancelled", () => {
    const run = (name: string, conclusion: string | null, status = "COMPLETED") => ({
      __typename: "CheckRun" as const,
      name,
      status,
      conclusion,
    });
    const status = (context: string, state: string) => ({ __typename: "StatusContext" as const, context, state });
    const ci = (nodes: unknown[], hasNextPage = false) => {
      const raw = pr("hugo", 15387);
      raw.commits = {
        nodes: [
          { commit: { statusCheckRollup: { state: "FAILURE", contexts: { pageInfo: { hasNextPage }, nodes } } } },
        ],
      } as RawPullRequest["commits"];
      return toFacts(raw, outsider).ci;
    };
    // GitHub's rollup counts a cancelled run as a failure; skipped and neutral ones pass.
    expect(ci([run("test", "SUCCESS"), run("lint", "CANCELLED"), run("e2e", "SKIPPED"), run("x", "NEUTRAL")])).toBe(
      "cancelled",
    );
    // A cancelled run of a check that ran again counts as that run.
    expect(ci([run("test", "CANCELLED"), run("test", "SUCCESS")])).toBe("success");
    expect(ci([run("test", "CANCELLED"), run("test", null, "IN_PROGRESS")])).toBe("pending");
    expect(ci([run("test", "CANCELLED"), run("test", "FAILURE")])).toBe("failure");
    // Anything else failing is a failure, cancelled runs or not; then anything running is pending.
    expect(ci([run("lint", "CANCELLED"), run("test", "TIMED_OUT")])).toBe("failure");
    expect(ci([run("lint", "CANCELLED"), status("ci/legacy", "ERROR")])).toBe("failure");
    expect(ci([run("lint", "CANCELLED"), status("ci/legacy", "PENDING")])).toBe("pending");
    // Not every run is there to read, or none is: GitHub's word stands.
    expect(ci([run("lint", "CANCELLED")], true)).toBe("failure");
    expect(ci([])).toBe("failure");
    expect(PULL_REQUEST_FIELDS).toContain("... on CheckRun { name status conclusion }");
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
