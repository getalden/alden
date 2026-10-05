import { createInterface } from "node:readline/promises";
import {
  flushTelemetry,
  setTelemetryConsent,
  TELEMETRY_HOST,
  telemetryBlocked,
  telemetryConsent,
  track,
} from "@alden/core";
import type { TelemetryProperties } from "@alden/schema";
import type { Command } from "commander";
import { paint, shouldColor } from "./render/style.js";

type CommandName = TelemetryProperties<"command_run">["command"];
const KNOWN = new Set<string>([
  "queue",
  "open",
  "review",
  "ui",
  "stats",
  "feedback",
  "memory",
  "spend",
  "config",
  "auth",
  "doctor",
  "telemetry",
  "mcp",
  "comment",
  "send",
  "setup",
]);

/** The top-level command (`memory` for `alden memory add`). */
function commandName(command: Command): CommandName {
  let top = command;
  while (top.parent?.parent) top = top.parent;
  return (KNOWN.has(top.name()) ? top.name() : "other") as CommandName;
}

export const TELEMETRY_QUESTION = [
  "Help shape Alden? With your OK, Alden sends anonymous usage stats to its developers: which commands you run,",
  "how reviews go (counts, timings, the model used) and which way your feedback points. Never code, diffs, titles,",
  "paths, repo or user names. `alden telemetry show` shows exactly what's queued; `alden telemetry off` stops it.",
];

/**
 * Asks once, on the first interactive run, whether to send anonymous usage stats. Not in pipes, scripts, CI or for
 * --json output, and never when something has already turned it off. The default is no.
 */
export async function askTelemetryOnce(command: Command): Promise<void> {
  if (commandName(command) === "telemetry") return;
  if (!process.stdin.isTTY || !process.stdout.isTTY || telemetryBlocked()) return;
  if ((command.opts() as { json?: boolean }).json) return;
  if ((await telemetryConsent()) !== "unset") return;
  const color = shouldColor(process.stdout);
  console.log(paint(TELEMETRY_QUESTION.join("\n"), "dim", color));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer = "";
  try {
    answer = await rl.question("Send anonymous usage stats? [y/N] ");
  } finally {
    rl.close();
  }
  const yes = /^y(es)?$/i.test(answer.trim());
  await setTelemetryConsent(yes);
  console.log(
    paint(
      yes
        ? "Thank you. `alden telemetry off` stops it any time.\n"
        : "No stats will be sent. `alden telemetry on` if you change your mind.\n",
      "dim",
      color,
    ),
  );
  // The first run is also the moment to say a model is one command away, unless that's what's being run.
  const name = commandName(command);
  if (name !== "setup" && name !== "auth" && !process.env.ANTHROPIC_API_KEY) {
    console.log(paint(`${SETUP_HINT}\n`, "dim", color));
  }
}

export const SETUP_HINT =
  "Alden runs its checks with no model. To have a model read each change too, `alden setup` sets one up in a minute.";

/** Times every command and records it (when opted in), then sends what's queued, briefly. */
export function instrument(program: Command): void {
  const started = new WeakMap<Command, number>();
  program.hook("preAction", async (_this, action) => {
    started.set(action, Date.now());
    await askTelemetryOnce(action);
  });
  program.hook("postAction", async (_this, action) => {
    const command = commandName(action);
    // `alden ui` is still serving when its action returns; the server records and sends its own events.
    if (command === "ui") return;
    await track("command_run", {
      command,
      ok: !process.exitCode,
      duration_ms: Math.max(0, Date.now() - (started.get(action) ?? Date.now())),
    });
    await flushTelemetry({ timeoutMs: 1_500 });
  });
}

export function registerTelemetryCommand(program: Command): void {
  const telemetry = program
    .command("telemetry")
    .description("Anonymous usage stats: see whether they're on, turn them on or off, or see what's queued.")
    .action(async () => {
      const consent = await telemetryConsent();
      const blocked = telemetryBlocked();
      console.log(
        blocked
          ? `Off: ${blocked}.`
          : consent === "on"
            ? `On. Anonymous usage stats go to ${TELEMETRY_HOST} (PostHog, EU). \`alden telemetry off\` stops them.`
            : consent === "off"
              ? "Off. `alden telemetry on` sends anonymous usage stats to help shape Alden."
              : "Not set: Alden sends nothing until you say yes. `alden telemetry on` to help shape Alden.",
      );
      console.log("What can be sent: https://getalden.dev/docs/telemetry (and packages/schema/src/telemetry.ts).");
    });
  telemetry
    .command("on")
    .description("Send anonymous usage stats.")
    .action(async () => {
      const blocked = telemetryBlocked();
      await setTelemetryConsent(true);
      console.log(blocked ? `Saved, but nothing is sent while ${blocked}.` : "On. Thank you.");
    });
  telemetry
    .command("off")
    .description("Stop sending usage stats, and drop anything not yet sent.")
    .action(async () => {
      await setTelemetryConsent(false);
      console.log("Off. Nothing more will be sent, and anything queued was deleted.");
    });
  telemetry
    .command("show")
    .description("Print the events waiting to be sent, exactly as they'd be sent.")
    .action(async () => {
      const { queuedTelemetry } = await import("@alden/core");
      const events = queuedTelemetry();
      console.log(events.length === 0 ? "Nothing waiting to be sent." : JSON.stringify(events, null, 2));
    });
}
