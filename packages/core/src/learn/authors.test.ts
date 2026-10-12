import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentMarker, agentNote, authorName, loginSlug, prAuthor } from "./authors.js";

const pr = (author: string | null, authorIsBot = false, headRef = "main") => ({ author, authorIsBot, headRef });

describe("who wrote a PR", () => {
  it("tells bots from people, by GitHub's type or a [bot] login", () => {
    expect(prAuthor(pr("dependabot", true))).toEqual({ kind: "bot", id: "dependabot" });
    expect(prAuthor(pr("dependabot[bot]"))).toEqual({ kind: "bot", id: "dependabot" });
    expect(prAuthor(pr("app/renovate", true))).toEqual({ kind: "bot", id: "renovate" });
    expect(prAuthor(pr("renovate-bot"))).toEqual({ kind: "bot", id: "renovate-bot" });
    expect(prAuthor(pr("acme-ci[bot]"))).toEqual({ kind: "bot", id: "acme-ci" });
    expect(prAuthor(pr("Sam"))).toEqual({ kind: "person", id: "sam" });
    expect(prAuthor(pr(null))).toBeUndefined();
  });

  it("knows AI agents by their apps, however GitHub spells them", () => {
    expect(prAuthor(pr("Copilot", true))).toEqual({ kind: "agent", id: "copilot" });
    expect(prAuthor(pr("copilot-swe-agent[bot]"))).toEqual({ kind: "agent", id: "copilot" });
    expect(prAuthor(pr("claude[bot]"))).toEqual({ kind: "agent", id: "claude" });
    expect(prAuthor(pr("devin-ai-integration", true))).toEqual({ kind: "agent", id: "devin" });
    expect(prAuthor(pr("cursor[bot]"))).toEqual({ kind: "agent", id: "cursor" });
    expect(prAuthor(pr("chatgpt-codex-connector[bot]"))).toEqual({ kind: "agent", id: "codex" });
    expect(prAuthor(pr("openhands-agent"))).toEqual({ kind: "agent", id: "openhands" });
  });

  it("keeps a person whose login is an agent's name a person", () => {
    expect(prAuthor(pr("claude"))).toEqual({ kind: "person", id: "claude" });
  });

  it("counts a person's PR from an agent's branch as the agent's, and the person's", () => {
    expect(prAuthor(pr("sam", false, "claude/issue-12-20260901"))).toEqual({
      kind: "agent",
      id: "claude",
      person: "sam",
      via: "branch",
    });
    expect(prAuthor(pr("me", false, "copilot/fix-login"), "Me")).toEqual({
      kind: "agent",
      id: "copilot",
      via: "branch",
    });
  });

  it("counts a person's PR with an agent's marker as the agent's, and the person's", () => {
    const marked = { ...pr("sam"), agentMarker: { agent: "cursor", in: "commit" as const } };
    expect(prAuthor(marked)).toEqual({ kind: "agent", id: "cursor", person: "sam", via: "commit" });
    expect(agentNote(prAuthor(marked))).toBe("by Cursor (from its last commit)");
    // The account or the branch says it first; a bot's PR stays the bot's.
    expect(prAuthor({ ...marked, headRef: "claude/x" })).toMatchObject({ id: "claude", via: "branch" });
    expect(prAuthor({ ...marked, author: "dependabot[bot]" })).toEqual({ kind: "bot", id: "dependabot" });
    // An agent's own account needs no note: its login says who it is.
    expect(agentNote(prAuthor(pr("claude[bot]")))).toBeUndefined();
    expect(agentNote(prAuthor(pr("sam")))).toBeUndefined();
  });

  it("knows your own PRs", () => {
    expect(prAuthor(pr("Me"), "me")).toEqual({ kind: "you" });
  });

  it("names bots and agents as people say them", () => {
    expect(loginSlug(" Dependabot[bot] ")).toBe("dependabot");
    expect(authorName("bot", "dependabot")).toBe("Dependabot");
    expect(authorName("agent", "codex")).toBe("Codex");
    expect(authorName("bot", "acme-ci")).toBe("acme-ci");
  });
});

describe("agents' markers on the recorded PRs", () => {
  it("finds Claude Code's footer on the one recorded PR that has it, and nothing on the rest", () => {
    // Real descriptions, some with AI-assistance disclosures in prose (django's template asks for one).
    const dir = join(import.meta.dirname, "../github/__fixtures__");
    const found = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) =>
        (
          JSON.parse(readFileSync(join(dir, f), "utf8")) as { pullRequests: { number: number; body?: string }[] }
        ).pullRequests.map((pr) => [`${f.replace(".json", "")}#${pr.number}`, agentMarker({ description: pr.body })]),
      )
      .filter(([, marker]) => marker);
    expect(found).toEqual([["reg-prometheus#19183", { agent: "claude", in: "description" }]]);
  });
});
