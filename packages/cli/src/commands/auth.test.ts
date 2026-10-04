import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readSecret } from "./auth.js";

/** A fake terminal: records raw mode, and what was written back (which must never include the secret). */
function terminal() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void };
  const modes: boolean[] = [];
  input.isTTY = true;
  input.setRawMode = (on) => {
    modes.push(on);
  };
  let shown = "";
  const output = new PassThrough();
  output.on("data", (chunk: Buffer) => {
    shown += chunk.toString();
  });
  return { input, output, modes, shown: () => shown };
}

describe("readSecret", () => {
  it("reads a line in raw mode without echoing it, and handles backspace", async () => {
    const t = terminal();
    const read = readSecret("Key: ", t.input as unknown as NodeJS.ReadStream, t.output);
    t.input.write("sk-ant-api03-abcx\u007f");
    t.input.write("d\r");
    expect(await read).toBe("sk-ant-api03-abcd");
    expect(t.modes).toEqual([true, false]);
    await new Promise((r) => setImmediate(r));
    expect(t.shown()).toBe("Key: \n");
  });

  it("cancels on Ctrl+C", async () => {
    const t = terminal();
    const read = readSecret("Key: ", t.input as unknown as NodeJS.ReadStream, t.output);
    t.input.write("sk-\u0003");
    await expect(read).rejects.toThrow("Cancelled.");
    expect(t.modes).toEqual([true, false]);
  });
});
