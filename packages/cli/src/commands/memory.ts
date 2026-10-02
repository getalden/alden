import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { addNote, forget, loadLearning, memoryItems, openStore, repoFromRemote } from "@alden/core";
import type { MemoryItem } from "@alden/schema";
import type { Command } from "commander";
import { paint, shouldColor, stripControlDeep } from "../render/style.js";

/** The GitHub repo of the clone around `cwd`, from its origin remote. */
export async function originOf(cwd: string = process.cwd()): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("git", ["remote", "get-url", "origin"], { cwd });
    return repoFromRemote(stdout.trim());
  } catch {
    return undefined;
  }
}

export function renderMemory(repo: string, untrusted: MemoryItem[], color: boolean): string {
  const items = stripControlDeep(untrusted);
  const out = [paint(`What Alden knows about you in ${repo}`, "bold", color), ""];
  if (items.length === 0) {
    out.push(
      "Nothing yet. Alden learns from the flags you agree with or mark not needed, and from the PRs you open first.",
      'Add a note yourself: alden memory add "Check that new endpoints have auth"',
    );
    return `${out.join("\n")}\n`;
  }
  const section = (title: string, list: MemoryItem[]) => {
    if (list.length === 0) return;
    out.push(paint(title, "bold", color));
    for (const item of list) {
      out.push(`  ${item.text}`);
      const detail = [item.evidence, item.effect].filter(Boolean).join("; ");
      out.push(
        paint(`    ${detail ? `${detail} · ` : ""}since ${item.since.slice(0, 10)} · id ${item.id}`, "dim", color),
      );
    }
    out.push("");
  };
  section(
    "Your notes",
    items.filter((i) => i.source === "you"),
  );
  section(
    "Learned from your feedback",
    items.filter((i) => i.source === "learned"),
  );
  out.push(
    paint("Forget any of these with `alden memory forget <id>`. Nothing here leaves your machine.", "dim", color),
  );
  return `${out.join("\n")}\n`;
}

export function registerMemoryCommand(program: Command): void {
  const memory = program
    .command("memory")
    .description("What Alden has learned about you in a repo, and your own notes for it. Local only.")
    .option("--repo <owner/name>", "the repo (default: this clone's origin)")
    .option("--json", "print the items as JSON");

  const repoFrom = async (options: { repo?: string }) => {
    const repo = options.repo ?? (await originOf());
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      program.error("Run this in a clone with a GitHub origin, or pass --repo owner/name.");
    }
    return repo;
  };

  memory.action(async (options: { repo?: string; json?: boolean }) => {
    const repo = await repoFrom(options);
    const items = memoryItems(await loadLearning(openStore(), repo));
    if (options.json) console.log(JSON.stringify(items, null, 2));
    else process.stdout.write(renderMemory(repo, items, shouldColor(process.stdout)));
  });

  memory
    .command("add")
    .description("Add a note on what you care about; the model gets it with every review of this repo.")
    .argument("<text...>", 'e.g. "Check that new endpoints have auth"')
    .option("--repo <owner/name>", "the repo (default: this clone's origin)")
    .action(async (words: string[], options: { repo?: string }) => {
      const repo = await repoFrom({ ...memory.opts(), ...options });
      try {
        const event = addNote(openStore(), repo, words.join(" "));
        console.log(
          `Noted for ${repo}${event.action === "add" ? ` (id ${event.item})` : ""}. The model gets it with every review here.`,
        );
      } catch (error) {
        program.error((error as Error).message);
      }
    });

  memory
    .command("forget")
    .description("Forget a note, or something Alden learned (it starts learning that again from scratch).")
    .argument("<id>", "the id `alden memory` shows")
    .option("--repo <owner/name>", "the repo (default: this clone's origin)")
    .action(async (id: string, options: { repo?: string }) => {
      const repo = await repoFrom({ ...memory.opts(), ...options });
      if (!(await forget(openStore(), repo, id))) {
        program.error(`Nothing called ${id} in ${repo}. \`alden memory\` lists the ids.`);
      }
      console.log(`Forgotten: ${id}.`);
    });
}
