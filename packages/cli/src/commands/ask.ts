import { JsonCache, MAX_QUESTION_CHARS } from "@alden/core";
import type { Command } from "commander";
import { parsePrRef, queuePick } from "../pr-ref.js";
import { paint, shouldColor, stripControl } from "../render/style.js";
import { createUiApi } from "../ui/api.js";
import { originOf } from "./memory.js";
import { LAST_QUEUE_KEY, type LastQueue } from "./open.js";

/** What `alden ask` prints once the answer is in: what it cost and with which model. */
export function costLine(done: { costUsd: number | null; model: string }): string {
  const cost =
    done.costUsd === null
      ? "no known price"
      : `$${done.costUsd < 0.01 ? done.costUsd.toFixed(4) : done.costUsd.toFixed(2)}`;
  return `${done.model} · ${cost}`;
}

/**
 * `alden ask <pr> "question"`: a question about a PR, answered by your model with the PR's latest briefing, the diff
 * around the places that matter and your notes. One call within your caps; the answer streams as it's written and
 * isn't kept.
 */
export function registerAskCommand(program: Command, version: string): void {
  program
    .command("ask")
    .description(
      "Ask your model a question about a PR, answered from its latest briefing (brief it first with alden review), the diff around the places that matter and your notes. One call within your budget caps; the answer isn't kept.",
    )
    .argument("<pr>", "a PR URL, owner/repo#123, or a # from `alden queue`")
    .argument("<question...>", 'what you want to know, e.g. "Does anything still read the old column?"')
    .option("--model <name>", "a model for this question only (an alias like opus, or a model id)")
    .action(async (prArg: string, words: string[], options: { model?: string }) => {
      const question = words.join(" ").trim();
      if (!question) program.error('Ask a question: alden ask <pr> "your question".');
      if (question.length > MAX_QUESTION_CHARS) {
        program.error(`That question is over ${MAX_QUESTION_CHARS} characters: ask something shorter.`);
      }
      const last = await new JsonCache().get<LastQueue>(LAST_QUEUE_KEY, 24 * 3_600_000);
      let pr: string;
      try {
        const ref = parsePrRef(prArg, last?.urls);
        const picked = queuePick(prArg, ref, await originOf(), "alden ask");
        if (picked) console.error(picked);
        pr = `${ref.repo}#${ref.number}`;
      } catch (error) {
        program.error((error as Error).message);
      }
      const color = shouldColor(process.stdout);
      const stop = new AbortController();
      const interrupted = () => stop.abort();
      process.once("SIGINT", interrupted);
      let wrote = "";
      try {
        const done = await createUiApi({ version, cwd: process.cwd() }).ask(
          { pr, question, ...(options.model ? { model: options.model } : {}) },
          (delta) => {
            // The answer can quote the PR: printed, never run.
            const text = stripControl(delta);
            wrote += text;
            process.stdout.write(text);
          },
          stop.signal,
        );
        if (wrote && !wrote.endsWith("\n")) process.stdout.write("\n");
        console.error(paint(costLine(done), "dim", color));
      } catch (error) {
        if (wrote && !wrote.endsWith("\n")) process.stdout.write("\n");
        program.error((error as Error).message);
      } finally {
        process.off("SIGINT", interrupted);
      }
    });
}
