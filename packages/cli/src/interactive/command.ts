import { flushTelemetry, resolveToken, track } from "@alden/core";
import type { Command } from "commander";
import { shouldColor } from "../render/style.js";
import { askTelemetryOnce } from "../telemetry.js";
import { startInteractive } from "./app.js";
import { createEngine } from "./engine.js";

/**
 * `alden` with no command, in a terminal: the queue, briefings, feedback, comments and sending, on one screen. Counted
 * (when you've said yes to usage stats) as the command "interactive", with whether it ended well and how long it ran.
 */
export async function runInteractiveCommand(program: Command, version: string): Promise<void> {
  const started = Date.now();
  // Asked before the screen changes, as every command asks it.
  await askTelemetryOnce(program);
  if (!(await resolveToken())) {
    console.error("Not signed in. Run `alden auth login`, then `alden` again.");
    process.exitCode = 1;
    return;
  }
  let ok = false;
  try {
    const session = startInteractive({
      engine: createEngine({ version, cwd: process.cwd() }),
      input: process.stdin,
      output: process.stdout,
      color: shouldColor(process.stdout),
      animate: true,
      guardProcess: true,
    });
    await session.done;
    ok = true;
  } finally {
    await track("command_run", { command: "interactive", ok, duration_ms: Math.max(0, Date.now() - started) });
    await flushTelemetry({ timeoutMs: 1_500 });
  }
}
