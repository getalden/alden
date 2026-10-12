import { flushTelemetry, modelSetupState, resolveToken, track } from "@alden/core";
import type { Command } from "commander";
import { signInToGitHub } from "../commands/auth.js";
import { realSteps, runSetup, terminalIo } from "../commands/setup.js";
import { shouldColor } from "../render/style.js";
import { askTelemetryOnce } from "../telemetry.js";
import { startInteractive } from "./app.js";
import { createEngine } from "./engine.js";
import { runFirstRun } from "./first-run.js";

/**
 * `alden` with no command, in a terminal: the queue, briefings, feedback, comments and sending, on one screen. Counted
 * (when you've said yes to usage stats) as the command "interactive", with whether it ended well and how long it ran.
 */
export async function runInteractiveCommand(program: Command, version: string): Promise<void> {
  const started = Date.now();
  // Asked before the screen changes, as every command asks it.
  await askTelemetryOnce(program);
  // Signed out: the first run, as in the app. Sign in, a model (or not), then the queue.
  if (!(await resolveToken())) {
    const open = await runFirstRun(terminalIo(), {
      signIn: () => signInToGitHub({ device: false }),
      signedIn: async () => (await resolveToken()) !== undefined,
      modelState: () => modelSetupState(),
      setUp: () => runSetup(terminalIo(), realSteps),
    });
    if (!open) {
      process.exitCode = 1;
      return;
    }
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
