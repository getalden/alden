import { describe, expect, it } from "vitest";
import { parseKeys } from "./keys.js";

const names = (data: string) => parseKeys(data).map((k) => (k.name === "char" ? k.text : k.name));

describe("parseKeys", () => {
  it("reads letters typed together as keys, one each", () => {
    expect(names("jjk")).toEqual(["j", "j", "k"]);
  });

  it("reads arrows, paging and Home/End in both forms terminals send", () => {
    expect(names("\u001b[A\u001b[B\u001bOC\u001bOD")).toEqual(["up", "down", "right", "left"]);
    expect(names("\u001b[5~\u001b[6~\u001b[H\u001b[4~")).toEqual(["pageup", "pagedown", "home", "end"]);
    expect(names("\u001b[Z")).toEqual(["backtab"]);
  });

  it("reads Enter, Backspace, Tab, Ctrl-C and Ctrl-U, and a pasted CR LF as one Enter", () => {
    expect(names("\r\u007f\b\t\u0003\u0015")).toEqual(["enter", "backspace", "backspace", "tab", "ctrl-c", "ctrl-u"]);
    expect(names("a\r\nb")).toEqual(["a", "enter", "b"]);
  });

  it("reads a lone Escape, and Alt+key as Escape then the key", () => {
    expect(names("\u001b")).toEqual(["escape"]);
    expect(names("\u001bq")).toEqual(["escape", "q"]);
  });

  it("drops unknown sequences and stray control characters rather than typing them", () => {
    expect(names("\u001b[15~x\u0007\u001b[<0;3;4M")).toEqual(["x"]);
  });

  it("keeps an emoji or an accent as one character", () => {
    expect(names("é🙂")).toEqual(["é", "🙂"]);
  });
});
