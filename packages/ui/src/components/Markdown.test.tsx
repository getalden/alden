// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { blocksOf, Markdown } from "./Markdown";

describe("Markdown", () => {
  it("reads paragraphs, lists, headings and code blocks", () => {
    expect(
      blocksOf(
        "Biggest risks:\n\n- **No actual fix**: the diff\n  only adds a comment\n- Two\n\n1. One\n2. Two\n\n## Next\n```py\nx = 1\n```",
      ),
    ).toEqual([
      { kind: "p", text: "Biggest risks:" },
      { kind: "ul", items: ["**No actual fix**: the diff only adds a comment", "Two"] },
      { kind: "ol", items: ["One", "Two"] },
      { kind: "h", text: "Next" },
      { kind: "code", text: "x = 1" },
    ]);
  });

  it("renders bold, inline code and lists as elements", () => {
    const { container } = render(<Markdown text={"- **No actual fix**: only `// hotfix` in `ts/src/cart.ts:18`"} />);
    expect(container.querySelector("li strong")?.textContent).toBe("No actual fix");
    expect([...container.querySelectorAll("li code")].map((c) => c.textContent)).toEqual([
      "// hotfix",
      "ts/src/cart.ts:18",
    ]);
    expect(container.textContent).not.toContain("**");
  });

  it("never turns text into HTML, and links only to http(s)", () => {
    const { container } = render(
      <Markdown text={'<img src=x onerror="alert(1)"> and [a](javascript:alert(1)) and [b](https://example.com)'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com"]);
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
