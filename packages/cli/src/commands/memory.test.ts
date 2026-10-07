import { describe, expect, it } from "vitest";
import { renderMemory } from "./memory.js";

describe("renderMemory", () => {
  it("says how Alden learns when it knows nothing yet", () => {
    expect(renderMemory("acme/shop", [], false)).toContain("Nothing yet. Alden learns from what you mark useful");
  });

  it("says how often a note was confirmed and where you stopped it", () => {
    const out = renderMemory(
      "acme/shop",
      [
        {
          id: "note:owners",
          repo: "acme/shop",
          source: "you",
          kind: "note",
          group: "look",
          text: "Every file needs a code owner header",
          effect: "Given to the model with every review of this repo, except under app/api, vendor.",
          confirmed: 3,
          excluded: ["app/api", "vendor"],
          since: "2026-09-20T10:00:00.000Z",
        },
      ],
      false,
    );
    expect(out).toContain(
      [
        "  Every file needs a code owner header",
        "    you said; confirmed 3×; Given to the model with every review of this repo · since 2026-09-20 · id note:owners",
        "    not applied under app/api, vendor · alden memory include <id> <path>",
      ].join("\n"),
    );
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
});
