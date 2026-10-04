import { describe, expect, it } from "vitest";
import { stripControl, wrap } from "./style.js";

describe("stripControl", () => {
  it("removes whole colour and cursor sequences, not just the escape character", () => {
    expect(stripControl("\u001b[31mred\u001b[0m and \u001b[1;4mbold\u001b[22m")).toBe("red and bold");
    expect(stripControl("\u001b[?25lhidden cursor\u001b[2J\u001b[H")).toBe("hidden cursor");
    expect(stripControl("\u009b31mC1 form")).toBe("C1 form");
  });

  it("removes links, window titles and clipboard writes, with either terminator", () => {
    expect(stripControl("\u001b]8;;https://evil.example\u0007click me\u001b]8;;\u0007")).toBe("click me");
    expect(stripControl("\u001b]8;;https://evil.example\u001b\\click me\u001b]8;;\u001b\\")).toBe("click me");
    expect(stripControl("\u001b]52;c;cGF3bmVk\u0007Fix\u001b]0;pwned\u0007 it")).toBe("Fix it");
    expect(stripControl("\u001bPq#0;2;0;0;0\u001b\\sixel")).toBe("sixel");
  });

  it("removes short escapes and lone control characters", () => {
    expect(stripControl("\u001b(Bcharset\u001bc reset\u001b7")).toBe("charset reset");
    expect(stripControl("bell\u0007 back\bspace car\rriage del\u007f c1\u0085")).toBe("bell backspace carriage del c1");
  });

  it("keeps an unterminated sequence's text visible, minus its control characters", () => {
    expect(stripControl("\u001b]0;never ends")).toBe("0;never ends");
  });

  it("keeps newlines, tabs, accents and emoji", () => {
    const text = "Café: naïve façade 🎉👩‍💻\n\tdone — 日本語";
    expect(stripControl(text)).toBe(text);
  });
});

describe("wrap", () => {
  it("wraps words to the width under an indent", () => {
    expect(wrap("one two three four", 13, "  ")).toEqual(["  one two", "  three four"]);
  });
});
