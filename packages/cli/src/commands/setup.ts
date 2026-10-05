import { createInterface } from "node:readline/promises";
import {
  ALDEN_CLOUD_URL,
  ANTHROPIC_KEYS_URL,
  modelSetupState,
  OLLAMA_DOWNLOAD_URL,
  OLLAMA_URL,
  type PullProgress,
  pullOllamaModel,
  setUpModelKey,
  useLocalModel,
} from "@alden/core";
import type { KeyTestResult, ModelSetupState } from "@alden/schema";
import type { Command } from "commander";
import { paint, shouldColor } from "../render/style.js";
import { readSecret } from "./auth.js";

/** The last line of every setup, on every surface. The page is a waitlist until the hosted Alden exists. */
export const CLOUD_LINE = `If you'd rather Alden handled everything, sign up for Alden Cloud (beta): ${ALDEN_CLOUD_URL}`;

/** Honest about the trade-off, wherever a local model is offered. */
export const LOCAL_CAVEAT = "Local models flag less than Claude: expect fewer findings, and more missed.";

/** How `alden setup` talks to the person. A terminal in real use; scripted in tests. */
export interface SetupIo {
  /** `quiet`: printed dim on a terminal, for asides. */
  print(text: string, quiet?: boolean): void;
  ask(question: string): Promise<string>;
  /** Reads a line without showing it. */
  secret(question: string): Promise<string>;
  /** One line of progress, redrawn in place on a terminal; `done` ends it. */
  progress(text: string, done?: boolean): void;
}

/** What `alden setup` does, so tests can fake the keychain, Anthropic and Ollama. */
export interface SetupSteps {
  state(): Promise<ModelSetupState>;
  setUpKey(key: string, untested: boolean): Promise<KeyTestResult>;
  pull(model: string, url: string, onProgress: (progress: PullProgress) => void): Promise<void>;
  useLocal(model: string, url: string): Promise<string>;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} kB`;
}

/** What reviews use now, in one line. */
export function describeCurrent(state: ModelSetupState): string {
  const { current, key } = state;
  if (!current.available) return "no model set up, so reviews run the checks only.";
  if (current.provider === "anthropic")
    return `${current.model} via Anthropic, using ${key?.where ?? "your setup"}.`;
  if (current.provider === "openai-compatible") return `${current.model}, a local model (openai-compatible).`;
  return `${current.model} via ${current.provider}.`;
}

function ollamaLine(state: ModelSetupState): string {
  const { ollama } = state;
  if (!ollama.reachable) return `through Ollama (not running at ${ollama.url})`;
  const n = ollama.models.length;
  return `free and private, through Ollama (running, ${n} model${n === 1 ? "" : "s"} pulled)`;
}

/** Not a terminal: what `alden setup` would offer, and the commands that do each by hand. */
export function setupPlan(state: ModelSetupState): string {
  const rec = state.recommendation;
  const local = [
    ...(state.ollama.reachable ? [] : [`     # Install and start Ollama first: ${OLLAMA_DOWNLOAD_URL}`]),
    ...(rec.installed ? [] : [`     ollama pull ${rec.model}          # about ${rec.download}`]),
    "     alden config set model.provider openai-compatible",
    `     alden config set model.name ${rec.model}`,
    ...(state.ollama.url === OLLAMA_URL ? [] : [`     alden config set model.baseUrl ${state.ollama.url}/v1`]),
  ];
  return [
    "alden setup asks its questions in a terminal. Here's what it offers, and how to do each by hand.",
    "",
    `Now: ${describeCurrent(state)}`,
    "",
    `1) Paste an Anthropic API key, from ${ANTHROPIC_KEYS_URL}:`,
    "     alden auth model            # reads the key from standard input when piped",
    `2) Use a local model, ${ollamaLine(state)}. For ${state.memoryGb} GB of memory: ${rec.model} (${rec.why}).`,
    ...local,
    `     ${LOCAL_CAVEAT}`,
    "3) Checks only: nothing to do. Reviews run Alden's checks and find callers, with no model.",
    "",
    CLOUD_LINE,
    "",
  ].join("\n");
}

/** The interactive setup: choose a key, a local model or checks only. Returns whether a model now works. */
export async function runSetup(io: SetupIo, steps: SetupSteps): Promise<boolean> {
  const state = await steps.state();
  io.print(`Set up a model\n\nNow: ${describeCurrent(state)}\n`);
  io.print("  1  Paste an Anthropic API key   Claude: the most thorough briefings");
  io.print(`  2  Use a local model            ${ollamaLine(state)}`);
  io.print("  3  Checks only                  no model: Alden's checks and callers, at no cost\n");
  const choice = (await io.ask("Choose 1, 2 or 3 [1]: ")).trim() || "1";

  let ok: boolean;
  if (choice === "1") ok = await keyStep(io, steps);
  else if (choice === "2") ok = await localStep(io, steps, state);
  else if (choice === "3") {
    io.print("Checks only: reviews run Alden's checks and find callers, with no model and no cost.");
    io.print("Run `alden setup` any time to add one.");
    ok = true;
  } else {
    io.print(`"${choice}" isn't 1, 2 or 3. Nothing changed; run \`alden setup\` again.`);
    ok = false;
  }
  io.print(`\n${CLOUD_LINE}`, true);
  return ok;
}

async function keyStep(io: SetupIo, steps: SetupSteps): Promise<boolean> {
  io.print(`\nCreate a key at ${ANTHROPIC_KEYS_URL}, then paste it here.`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = await io.secret("Anthropic API key (it won't show as you paste): ");
    if (!key) {
      io.print("No key given. Nothing changed.");
      return false;
    }
    io.print("Checking it with one tiny request (a fraction of a cent)…");
    let result = await steps.setUpKey(key, false);
    if (!result.ok && (result.reason === "network" || result.reason === "unavailable")) {
      io.print(result.message);
      const anyway = await io.ask("Store it anyway, without the check? [y/N] ");
      if (/^y(es)?$/i.test(anyway.trim())) result = await steps.setUpKey(key, true);
      else return false;
    }
    if (result.ok) {
      io.print("It works. Stored for the terminal, alden ui, alden mcp and the desktop app; reviews now ask Claude.");
      if (result.key?.source === "env") {
        io.print(`${result.key.where} is set here and comes first; the stored key is used where it isn't.`);
      }
      return true;
    }
    io.print(result.message);
    if (result.reason !== "shape" && result.reason !== "invalid") return false;
    const again = await io.ask("Paste another? [Y/n] ");
    if (/^n(o)?$/i.test(again.trim())) return false;
  }
  return false;
}

async function localStep(io: SetupIo, steps: SetupSteps, state: ModelSetupState): Promise<boolean> {
  const { ollama, recommendation: rec } = state;
  if (!ollama.reachable) {
    io.print(`\n${ollama.reason ?? `Ollama isn't running at ${ollama.url}.`}`);
    io.print(
      `Install it from ${OLLAMA_DOWNLOAD_URL} (or \`brew install ollama\`), start it, then run \`alden setup\` again.`,
    );
    return false;
  }
  const options: { model: string; pull: boolean; note: string }[] = [
    ...(rec.installed
      ? []
      : [{ model: rec.model, pull: true, note: `download about ${rec.download}; recommended, ${rec.why}` }]),
    ...ollama.models.map((m) => ({
      model: m.name,
      pull: false,
      note: [m.sizeBytes ? formatBytes(m.sizeBytes) : "", m.name === rec.model ? `recommended, ${rec.why}` : ""]
        .filter(Boolean)
        .join("; "),
    })),
  ];
  io.print(
    `\nOllama${ollama.version ? ` ${ollama.version}` : ""} at ${ollama.url}. This machine has ${state.memoryGb} GB of memory.`,
  );
  const width = Math.max(...options.map((o) => o.model.length));
  options.forEach((o, i) => {
    io.print(`  ${i + 1}  ${(o.pull ? "Pull" : "Use").padEnd(5)}${o.model.padEnd(width)}  ${o.note}`);
  });
  io.print(LOCAL_CAVEAT, true);
  const answer = (await io.ask(`Which? [1]: `)).trim() || "1";
  const picked = options[Number(answer) - 1];
  if (!picked || String(Number(answer)) !== answer) {
    io.print(`"${answer}" isn't on the list. Nothing changed.`);
    return false;
  }
  if (picked.pull) {
    io.print(`Pulling ${picked.model} with Ollama (about ${rec.download}); this can take a while. Ctrl+C stops it.`);
    try {
      await steps.pull(picked.model, ollama.url, (p) => {
        const share =
          p.total && p.completed !== null
            ? ` ${Math.floor((p.completed / p.total) * 100)}% of ${formatBytes(p.total)}`
            : "";
        io.progress(`${p.status}${share}`);
      });
      io.progress("", true);
    } catch (error) {
      io.progress("", true);
      io.print((error as Error).message);
      return false;
    }
  }
  await steps.useLocal(picked.model, ollama.url);
  io.print(`Reviews now use ${picked.model} on Ollama. Run \`alden setup\` again to switch.`);
  return true;
}

/** A terminal for `runSetup`: prompts on stdout, the key read without echo, progress redrawn on stderr. */
function terminalIo(): SetupIo {
  const color = shouldColor(process.stdout);
  return {
    print: (text, quiet) => console.log(quiet ? paint(text, "dim", color) : text),
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    secret: (question) => readSecret(question, process.stdin, process.stdout),
    progress(text, done) {
      if (!process.stderr.isTTY) return;
      process.stderr.write(done ? "\r\u001b[2K" : `\r${text}\u001b[K`);
    },
  };
}

export const realSteps: SetupSteps = {
  state: () => modelSetupState(),
  setUpKey: (key, untested) => setUpModelKey(key, { untested }),
  pull: (model, url, onProgress) => pullOllamaModel(model, onProgress, { url }),
  useLocal: (model, url) => useLocalModel(model, url),
};

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description(
      "Set up a model: paste an Anthropic API key (checked with one tiny request), use a local model with Ollama, or run checks only.",
    )
    .action(async () => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stdout.write(setupPlan(await modelSetupState()));
        return;
      }
      try {
        if (!(await runSetup(terminalIo(), realSteps))) process.exitCode = 1;
      } catch (error) {
        program.error((error as Error).message);
      }
    });
}
