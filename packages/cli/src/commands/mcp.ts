import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { configureTelemetry, flushTelemetry } from "@alden/core";
import type { Command } from "commander";
import { serveMcp } from "../mcp/protocol.js";
import { aldenTools, INSTRUCTIONS } from "../mcp/tools.js";

export function registerMcpCommand(program: Command, version: string): void {
  program
    .command("mcp")
    .description("Serve Alden to an AI coding tool (Claude Code, Cursor…) as MCP tools over stdio.")
    .option("--dir <path>", "the clone to review local changes and find callers in (default: where it's started)")
    .addHelpText(
      "after",
      "\nAdd it to Claude Code with: claude mcp add alden -- alden mcp\nSee https://getalden.dev/docs/mcp/",
    )
    .action(async (options: { dir?: string }) => {
      const cwd = resolve(options.dir ?? process.cwd());
      if (!existsSync(cwd)) program.error(`--dir ${options.dir} doesn't exist.`);
      // stdout carries the protocol and nothing else: anything else printed goes to stderr.
      const output = process.stdout;
      console.log = console.error;
      console.info = console.error;

      configureTelemetry({ version, surface: "mcp" });
      const sender = setInterval(() => void flushTelemetry(), 60_000);
      sender.unref();
      await serveMcp({
        name: "alden",
        title: "Alden",
        version,
        instructions: INSTRUCTIONS,
        tools: aldenTools({ version, cwd }),
        output,
      });
      clearInterval(sender);
    });
}
