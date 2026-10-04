import { describe, expect, it } from "vitest";
import { isPureRename, onlyCommentsChanged } from "./comments.js";
import type { DiffFile, DiffLine } from "./parse.js";

/** A file whose one hunk is `lines`: "+x" added, "-x" removed, " x" context. */
function diff(path: string, lines: string[], extra: Partial<DiffFile> = {}): DiffFile {
  let oldLine = 1;
  let newLine = 1;
  const parsed: DiffLine[] = lines.map((l) => {
    const text = l.slice(1);
    if (l[0] === "+") return { kind: "add", text, newLine: newLine++ };
    if (l[0] === "-") return { kind: "del", text, oldLine: oldLine++ };
    return { kind: "context", text, oldLine: oldLine++, newLine: newLine++ };
  });
  return {
    path,
    status: "modified",
    additions: parsed.filter((l) => l.kind === "add").length,
    deletions: parsed.filter((l) => l.kind === "del").length,
    binary: false,
    patchMissing: false,
    hunks: [{ header: "@@", oldStart: 1, oldLines: oldLine - 1, newStart: 1, newLines: newLine - 1, lines: parsed }],
    ...extra,
  };
}

describe("onlyCommentsChanged", () => {
  it("sees line and block comments and blank lines in TS, Go and PHP", () => {
    expect(onlyCommentsChanged(diff("src/a.ts", ["-// old", "+// new", "+", " const x = 1;"]))).toBe(true);
    expect(
      onlyCommentsChanged(diff("src/a.ts", ["+/**", "+ * Charges the card.", "+ */", " export function charge() {"])),
    ).toBe(true);
    expect(onlyCommentsChanged(diff("srv/s.go", ["+/* a", "+spans lines", "+*/", "+// x"]))).toBe(true);
    expect(onlyCommentsChanged(diff("app/A.php", ["+# note", "+// note", "+/* x */"]))).toBe(true);
  });

  it("sees Python comments and docstrings", () => {
    expect(onlyCommentsChanged(diff("a.py", ["+# why", " def f():", '+    """One line."""']))).toBe(true);
    expect(onlyCommentsChanged(diff("a.py", ['+    """', "+    Spans lines.", '+    """']))).toBe(true);
  });

  it("counts any code line as code", () => {
    expect(onlyCommentsChanged(diff("src/a.ts", ["+// note", "+const x = 2; // two"]))).toBe(false);
    expect(onlyCommentsChanged(diff("src/a.ts", ["-const x = 1;", "+// const x = 1;"]))).toBe(false);
    expect(onlyCommentsChanged(diff("a.py", ["+x = 1  # one"]))).toBe(false);
    // PHP 8 attributes start with # but are code.
    expect(onlyCommentsChanged(diff("app/A.php", ["+#[Route('/x')]"]))).toBe(false);
  });

  it("says no for languages it doesn't know, and for files without a diff", () => {
    expect(onlyCommentsChanged(diff("main.zig", ["+// note"]))).toBe(false);
    expect(onlyCommentsChanged(diff("src/a.ts", [], { hunks: [] }))).toBe(false);
  });
});

describe("isPureRename", () => {
  it("is a rename with no lines changed", () => {
    expect(
      isPureRename(diff("src/lib/pricing.ts", [], { status: "renamed", previousPath: "src/pricing.ts", hunks: [] })),
    ).toBe(true);
    expect(
      isPureRename(diff("src/lib/pricing.ts", ["+x"], { status: "renamed", previousPath: "src/pricing.ts" })),
    ).toBe(false);
  });
});
