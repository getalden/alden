import { describe, expect, it } from "vitest";
import { agentMarker, commitAgent, descriptionAgent } from "./agent-markers.js";

describe("AI agents' markers in a PR's description", () => {
  it("knows each agent's footer, as the tools write it", () => {
    expect(descriptionAgent("Adds retries.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)")).toBe(
      "claude",
    );
    expect(descriptionAgent("Adds retries.\r\n\r\nGenerated with [Claude Code](https://claude.ai/code)\r\n")).toBe(
      "claude",
    );
    expect(descriptionAgent("Adds retries.\n\n🤖 Generated with Claude Code")).toBe("claude");
    expect(
      descriptionAgent(
        "Fix login\n\nLink to Devin run: https://app.devin.ai/sessions/4f1c2a9be0d34c6f\nRequested by: @sam",
      ),
    ).toBe("devin");
    expect(descriptionAgent("Summary\n\n------\nhttps://chatgpt.com/codex/tasks/task_e_68a1b2c3d4e5")).toBe("codex");
    expect(
      descriptionAgent('<a href="https://cursor.com/background-agent?bcId=bc-1a2b3c4d-5e6f">Open in Cursor</a>'),
    ).toBe("cursor");
    expect(
      descriptionAgent("*PR created automatically by Jules for task [123456](https://jules.google.com/task/123456)*"),
    ).toBe("jules");
    expect(descriptionAgent("Fixes #12\n\n<!-- START COPILOT CODING AGENT SUFFIX -->\nOriginal prompt")).toBe(
      "copilot",
    );
  });

  it("isn't fooled by a PR that talks about an agent", () => {
    for (const prose of [
      "Claude suggested this approach, then I rewrote it.",
      "Removes the 'Generated with Claude Code' line our template added by mistake.",
      "We generated with Claude Code a first draft, then rewrote it by hand.",
      "Docs: `🤖 Generated with [Claude Code](https://claude.com/claude-code)` is what Claude Code adds.",
      "Detect agent PRs:\n\n```\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nhttps://app.devin.ai/sessions/4f1c2a9be0d34c6f\n```\n",
      "See https://app.devin.ai/ and https://chatgpt.com/codex for the tools we compared.",
      "Co-authored-by: Cursor Agent <cursoragent@cursor.com>",
      "",
    ]) {
      expect(descriptionAgent(prose), prose).toBeUndefined();
    }
    expect(descriptionAgent(null)).toBeUndefined();
  });
});

describe("AI agents' trailers in a commit message", () => {
  it("knows agents by their co-author's address", () => {
    expect(commitAgent("Fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>")).toBe("claude");
    expect(commitAgent("Fix\n\nCo-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>")).toBe("claude");
    expect(commitAgent("Fix\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>")).toBe("cursor");
    expect(commitAgent("Fix\n\nMade-with: Cursor")).toBe("cursor");
    expect(commitAgent("Fix\n\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>")).toBe("copilot");
    expect(
      commitAgent(
        "Fix\n\nCo-authored-by: devin-ai-integration[bot] <158243242+devin-ai-integration[bot]@users.noreply.github.com>",
      ),
    ).toBe("devin");
    expect(
      commitAgent(
        "Fix\n\nCo-authored-by: amazon-q-developer[bot] <208079219+amazon-q-developer[bot]@users.noreply.github.com>",
      ),
    ).toBe("amazon-q");
    expect(commitAgent("Fix\n\nCo-authored-by: openhands <openhands@all-hands.dev>")).toBe("openhands");
    expect(commitAgent("Fix\n\nCo-authored-by: aider (gpt-5) <noreply@aider.chat>")).toBe("aider");
    expect(commitAgent("Fix\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n")).toBe("claude");
  });

  it("never counts a name alone, a person's noreply address, or a trailer in prose", () => {
    expect(commitAgent("Fix\n\nCo-authored-by: Claude <claude@acme.dev>")).toBeUndefined();
    expect(commitAgent("Fix\n\nCo-authored-by: Claude <1234+claude@users.noreply.github.com>")).toBeUndefined();
    expect(commitAgent("Fix\n\nCo-authored-by: Sam <sam@acme.dev>")).toBeUndefined();
    expect(
      commitAgent("Strip lines like Co-authored-by: Claude <noreply@anthropic.com> from messages"),
    ).toBeUndefined();
    expect(
      commitAgent("Fix\n\nCo-authored-by: acme-ci[bot] <1+acme-ci[bot]@users.noreply.github.com>"),
    ).toBeUndefined();
    expect(commitAgent(undefined)).toBeUndefined();
  });
});

describe("an agent's marker on a PR", () => {
  it("reads the description first, then the last commit", () => {
    expect(
      agentMarker({
        description: "🤖 Generated with Claude Code",
        commitMessage: "x\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>",
      }),
    ).toEqual({ agent: "claude", in: "description" });
    expect(agentMarker({ description: "Fixes #1", commitMessage: "x\n\nMade-with: Cursor" })).toEqual({
      agent: "cursor",
      in: "commit",
    });
    expect(agentMarker({ description: "Fixes #1", commitMessage: "Fix the thing" })).toBeUndefined();
  });
});
