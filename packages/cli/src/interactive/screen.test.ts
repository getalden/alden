import { describe, expect, it } from "vitest";
import { frame, truncate, visibleWidth } from "./screen.js";

const red = (text: string) => `\u001b[31m${text}\u001b[39m`;

describe("drawing lines", () => {
  it("counts only what's visible", () => {
    expect(visibleWidth(red("hello"))).toBe(5);
    expect(visibleWidth("a🙂b")).toBe(3);
  });

  it("cuts a line to the width by what's visible, keeping its colour codes whole", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate(red("abcdefgh"), 5)).toBe("\u001b[31mabcd…\u001b[0m");
    expect(visibleWidth(truncate(red("abcdefgh"), 5))).toBe(5);
  });

  it("draws a frame from the top-left, clearing what's left of each row and below", () => {
    expect(frame(["one", "twotwo"], 6)).toBe("\u001b[Hone\u001b[0m\u001b[K\r\ntwotwo\u001b[0m\u001b[J");
  });
});
