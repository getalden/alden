import { describe, expect, it } from "vitest";
import { startProgress } from "./progress.js";

function fakeStream(isTTY: boolean, columns = 80) {
  const writes: string[] = [];
  const stream = { isTTY, columns, write: (text: string) => writes.push(text) } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

describe("startProgress", () => {
  it("writes nothing when the stream isn't a terminal", () => {
    const { stream, writes } = fakeStream(false);
    const progress = startProgress("Working…", stream);
    progress.update("Still working…");
    progress.stop();
    expect(writes).toEqual([]);
  });

  it("redraws one line in place with what it's doing now, and clears it when done", () => {
    const { stream, writes } = fakeStream(true);
    const progress = startProgress("Asking GitHub who you are…", stream);
    progress.update("Checking acme/\u001b[31mshop\u001b[0m (2 of 5)…");
    progress.stop();
    progress.update("too late");
    // Each draw: carriage return, a spinner frame, the label, the clock, then clear the rest of the line.
    expect(writes[0]?.slice(2)).toBe(" Asking GitHub who you are… 0s\u001b[K");
    // The repo name came from GitHub: its escape sequences don't reach the terminal.
    expect(writes[1]?.slice(2)).toBe(" Checking acme/shop (2 of 5)… 0s\u001b[K");
    expect(writes.at(-1)).toBe("\r\u001b[2K");
    expect(writes).toHaveLength(3);
  });

  it("cuts a long label to the terminal's width, keeping the clock", () => {
    const { stream, writes } = fakeStream(true, 40);
    startProgress("x".repeat(100), stream).stop();
    const line = (writes[0] as string).replace("\r", "").replace("\u001b[K", "");
    expect(line.length).toBeLessThan(40);
    expect(line).toMatch(/…\s0s$/);
  });
});
