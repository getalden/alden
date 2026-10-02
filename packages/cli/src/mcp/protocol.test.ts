import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, serveMcp } from "./protocol.js";

const echo = defineTool({
  name: "echo",
  title: "Echo",
  description: "Says it back.",
  input: z.object({ text: z.string(), times: z.number().int().default(1) }),
  annotations: { readOnlyHint: true },
  async call({ text, times }) {
    if (text === "boom") throw new Error("It went boom.");
    return text.repeat(times);
  },
});

/** Sends each message as a line, closes the input, and returns every reply. */
async function exchange(...messages: unknown[]): Promise<Record<string, unknown>[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const done = serveMcp({
    name: "t",
    title: "T",
    version: "1.2.3",
    instructions: "Use echo.",
    tools: [echo],
    input,
    output,
  });
  for (const m of messages) input.write(`${typeof m === "string" ? m : JSON.stringify(m)}\n`);
  input.end();
  await done;
  return chunks
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const call = (id: number, method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
});

describe("serveMcp", () => {
  it("initializes with the client's protocol version when it knows it, and its own otherwise", async () => {
    const [known, unknown] = await exchange(
      call(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "c", version: "1" },
      }),
      call(2, "initialize", { protocolVersion: "1999-01-01" }),
    );
    expect(known?.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "t", version: "1.2.3" },
      instructions: "Use echo.",
    });
    expect(unknown?.result).toMatchObject({ protocolVersion: "2025-11-25" });
  });

  it("lists tools with a JSON Schema for their input", async () => {
    const [reply] = await exchange(call(1, "tools/list"));
    const [tool] = (reply?.result as { tools: Record<string, unknown>[] } | undefined)?.tools ?? [];
    expect(tool).toMatchObject({ name: "echo", title: "Echo", annotations: { readOnlyHint: true } });
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
    });
    expect(tool?.inputSchema).not.toHaveProperty("$schema");
  });

  it("calls a tool with its defaults applied", async () => {
    const [reply] = await exchange(call(1, "tools/call", { name: "echo", arguments: { text: "hi", times: 2 } }));
    expect(reply?.result).toEqual({ content: [{ type: "text", text: "hihi" }] });
  });

  it("turns a tool's failure and bad arguments into results the model can read", async () => {
    const [failed, bad] = await exchange(
      call(1, "tools/call", { name: "echo", arguments: { text: "boom" } }),
      call(2, "tools/call", { name: "echo", arguments: { times: 2 } }),
    );
    expect(failed?.result).toEqual({ content: [{ type: "text", text: "It went boom." }], isError: true });
    expect(bad?.result).toMatchObject({ isError: true });
    expect(JSON.stringify(bad?.result)).toContain("text");
  });

  it("answers protocol errors, and nothing to notifications", async () => {
    const replies = await exchange(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      call(1, "resources/list"),
      call(2, "tools/call", { name: "nope" }),
      "not json",
      call(3, "ping"),
    );
    expect(replies.map((r) => (r.error as { code: number } | undefined)?.code ?? "ok")).toEqual([
      -32601,
      -32602,
      -32700,
      "ok",
    ]);
    expect(replies.at(-1)).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });
});
