import { describe, expect, it } from "vitest";
import { renderMemory } from "./memory.js";

describe("renderMemory", () => {
  it("says how Alden learns when it knows nothing yet", () => {
    expect(renderMemory("acme/shop", [], false)).toContain("Nothing yet. Alden learns from what you mark useful");
  });

  it("lists what you look for, then what you skip, with evidence, effect, date and id", () => {
    const out = renderMemory(
      "acme/shop",
      [
        {
          id: "note:1",
          repo: "acme/shop",
          source: "you",
          kind: "note",
          group: "look",
          text: "Cents, not floats",
          effect: "given to the model with every review",
          since: "2026-09-20T10:00:00.000Z",
        },
        {
          id: "queue:path:db/:down",
          repo: "acme/shop",
          source: "learned",
          kind: "queue",
          group: "skip",
          text: "You skip PRs touching db/\u001b[31m",
          evidence: "marked not useful 3 times",
          effect: "Ranked lower in your queue.",
          since: "2026-09-21T10:00:00.000Z",
        },
      ],
      false,
    );
    expect(out).toBe(
      [
        "What Alden knows about you in acme/shop",
        "",
        "What you look for",
        "  Cents, not floats",
        "    you said; given to the model with every review · since 2026-09-20 · id note:1",
        "",
        "What you skip",
        "  You skip PRs touching db/",
        "    marked not useful 3 times; Ranked lower in your queue · since 2026-09-21 · id queue:path:db/:down",
        "",
        "Forget any of these with `alden memory forget <id>`. Nothing here leaves your machine.",
        "",
      ].join("\n"),
    );
  });

  it("says which reviews a learned item came from", () => {
    const out = renderMemory(
      "acme/shop",
      [
        {
          id: "check:tests.missing:up",
          repo: "acme/shop",
          source: "learned",
          kind: "check",
          group: "look",
          text: "You find untested-change flags useful",
          evidence: "3 of 3 useful: you marked 1, 2 from comments in your reviews (acme/shop#412)",
          sources: [
            { from: "review", pr: "acme/shop#412", weight: 2, at: "2026-10-02T00:00:00.000Z" },
            { from: "reactions", weight: 1, at: "2026-10-01T00:00:00.000Z" },
          ],
          since: "2026-10-01T00:00:00.000Z",
        },
      ],
      false,
    );
    expect(out).toContain(
      "    3 of 3 useful: you marked 1, 2 from comments in your reviews (acme/shop#412) · since 2026-10-01 · id check:tests.missing:up\n    from your review of acme/shop#412 (2)\n",
    );
  });
});
