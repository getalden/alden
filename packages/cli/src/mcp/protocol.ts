import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

/**
 * Just enough of the Model Context Protocol for a tools-only server over stdio: newline-delimited JSON-RPC 2.0,
 * `initialize`, `ping`, `tools/list` and `tools/call` (https://modelcontextprotocol.io/specification). Alden needs
 * nothing else, and owning these hundred lines keeps the standalone binary free of another SDK.
 */

/** Protocol versions this server speaks, newest first. A client asking for one of these gets it; others get ours. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface McpTool<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Hints for the client: read-only tools can run without asking, for example. */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  call(args: z.infer<S>): Promise<string>;
}

export function defineTool<S extends z.ZodType>(tool: McpTool<S>): McpTool {
  return tool as unknown as McpTool;
}

interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export interface ServeOptions {
  name: string;
  title: string;
  version: string;
  /** Told to the client's model once, at the start: what the server is for and how to use its tools. */
  instructions: string;
  tools: McpTool[];
  input?: Readable;
  output?: Writable;
}

/** Serves until the input closes (the client went away). Nothing but protocol messages is written to the output. */
export async function serveMcp(options: ServeOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const tools = new Map(options.tools.map((t) => [t.name, t]));
  const listed = options.tools.map((t) => {
    const { $schema: _, ...inputSchema } = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema,
      ...(t.annotations ? { annotations: { title: t.title, ...t.annotations } } : {}),
    };
  });
  const send = (message: unknown): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id: Request["id"], result: unknown) => send({ jsonrpc: "2.0", id, result });
  const fail = (id: Request["id"], code: number, message: string) =>
    send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  async function handle(request: Request): Promise<void> {
    const { id, method, params = {} } = request;
    const isNotification = id === undefined;
    switch (method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return reply(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.name, title: options.title, version: options.version },
          instructions: options.instructions,
        });
      }
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, { tools: listed });
      case "tools/call": {
        const tool = tools.get(String(params.name));
        if (!tool) return fail(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
        const parsed = tool.input.safeParse(params.arguments ?? {});
        if (!parsed.success) {
          return reply(id, toolError(`Those arguments don't fit ${tool.name}: ${z.prettifyError(parsed.error)}`));
        }
        try {
          return reply(id, { content: [{ type: "text", text: await tool.call(parsed.data) }] } satisfies ToolResult);
        } catch (error) {
          return reply(id, toolError((error as Error).message));
        }
      }
      default:
        // Notifications (initialized, cancelled, …) need no answer; unknown requests get "method not found".
        if (!isNotification) fail(id, METHOD_NOT_FOUND, `Alden doesn't handle ${method}.`);
    }
  }

  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      fail(null, PARSE_ERROR, "That wasn't JSON.");
      continue;
    }
    const request = message as Partial<Request>;
    if (request?.jsonrpc !== "2.0" || typeof request.method !== "string") {
      // Responses to requests we never send, or garbage: answer only if it carries an id.
      if (request && "id" in request && !("result" in request || "error" in request)) {
        fail(request.id, INVALID_REQUEST, "Not a JSON-RPC 2.0 request.");
      }
      continue;
    }
    // Requests run side by side (a review can take a minute; a ping shouldn't wait for it).
    const job = handle(request as Request).catch((error: Error) => fail(request.id, -32603, error.message));
    pending.add(job);
    void job.finally(() => pending.delete(job));
  }
  await Promise.all(pending);
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
