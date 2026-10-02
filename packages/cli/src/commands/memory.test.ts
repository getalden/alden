import { describe, expect, it } from "vitest";
import { renderMemory } from "./memory.js";

describe("renderMemory", () => {
  it("says how Alden learns when it knows nothing yet", () => {
    expect(renderMemory("acme/shop", [], false)).toContain("Nothing yet. Alden learns from the flags you agree with");
  });

  it("lists notes, then learned items with evidence, effect, date and id", () => {
    const out = renderMemory(
      "acme/shop",
      [
        {
          id: "note:1",
          repo: "acme/shop",
          source: "you",
          kind: "note",
          text: "Cents, not floats",
          effect: "given to the model with every review",
          since: "2026-09-20T10:00:00.000Z",
        },
        {
          id: "open:path:db/",
          repo: "acme/shop",
          source: "learned",
          kind: "open",
          text: "You open PRs touching db/ first\u001b[31m",
          evidence: "opened ahead of their rank 3 of 4 times",
          effect: "ranked higher in your queue",
          since: "2026-09-21T10:00:00.000Z",
        },
      ],
      false,
    );
    expect(out).toBe(
      [
        "What Alden knows about you in acme/shop",
        "",
        "Your notes",
        "  Cents, not floats",
        "    given to the model with every review · since 2026-09-20 · id note:1",
        "",
        "Learned from your feedback",
        "  You open PRs touching db/ first[31m",
        "    opened ahead of their rank 3 of 4 times; ranked higher in your queue · since 2026-09-21 · id open:path:db/",
        "",
        "Forget any of these with `alden memory forget <id>`. Nothing here leaves your machine.",
        "",
      ].join("\n"),
    );
  });
});
