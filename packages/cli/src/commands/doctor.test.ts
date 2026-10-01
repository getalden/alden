import { describe, expect, it } from "vitest";
import { graphLanguages, renderDoctor } from "./doctor.js";

describe("alden doctor", () => {
  it("names the languages the graph reads, most files first, skipping the rest", () => {
    expect(graphLanguages(["a.ts", "b.tsx", "c.js", "d.go", "e.php", "f.blade.php", "README.md", "g.rb"])).toBe(
      "TypeScript/JavaScript (3), Go (1), PHP (1)",
    );
    expect(graphLanguages(["README.md"])).toBe("");
  });

  it("puts each fix under its problem and counts what needs a look", () => {
    const text = renderDoctor(
      [
        { area: "GitHub", status: "ok", detail: "@sam" },
        { area: "Model", status: "warn", detail: "none set up", fix: "Set ANTHROPIC_API_KEY." },
      ],
      false,
    );
    expect(text).toBe(
      "✓ GitHub  @sam\n! Model   none set up\n          Set ANTHROPIC_API_KEY.\n\n1 thing to look at above.\n",
    );
    expect(renderDoctor([{ area: "A", status: "ok", detail: "x" }], false)).toContain(
      "Everything Alden needs is in place.",
    );
  });
});
