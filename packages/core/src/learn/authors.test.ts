import { describe, expect, it } from "vitest";
import { authorName, loginSlug, prAuthor } from "./authors.js";

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
    });
    expect(prAuthor(pr("me", false, "copilot/fix-login"), "Me")).toEqual({ kind: "agent", id: "copilot" });
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
