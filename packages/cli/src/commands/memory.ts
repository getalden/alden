import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  addNote,
  editNote,
  forget,
  forgetAll,
  loadLearning,
  memoryItems,
  notePath,
  openStore,
  repoFromRemote,
  restore,
  scopeNote,
  setLearning,
} from "@alden/core";
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

export function renderMemory(repo: string, untrusted: MemoryItem[], color: boolean, paused = false): string {
  const items = stripControlDeep(untrusted);
  const out = [paint(`What Alden knows about you in ${repo}`, "bold", color), ""];
  if (paused)
    out.push(
      paint("Learning is paused here: this is kept but not applied. `alden memory resume`", "yellow", color),
      "",
    );
  if (items.length === 0) {
    out.push(
      "Nothing yet. Alden learns from what you mark useful or not useful, and from the PRs you open first.",
      'Add a note yourself: alden memory add "Check that new endpoints have auth"',
    );
    return `${out.join("\n")}\n`;
  }
  const section = (title: string, list: MemoryItem[]) => {
    if (list.length === 0) return;
    out.push(paint(title, "bold", color));
    for (const item of list) {
      out.push(`  ${item.text}`);
      const detail = [
        item.source === "you" ? "you said" : item.evidence,
        item.confirmed && `confirmed ${item.confirmed}×`,
        // A note's exclusions get their own line.
        item.excluded?.length ? "Given to the model with every review of this repo" : item.effect?.replace(/\.$/, ""),
      ]
        .filter(Boolean)
        .join("; ");
      out.push(
        paint(`    ${detail ? `${detail} · ` : ""}since ${item.since.slice(0, 10)} · id ${item.id}`, "dim", color),
      );
      if (item.excluded?.length) {
        out.push(
          paint(`    not applied under ${item.excluded.join(", ")} · alden memory include <id> <path>`, "dim", color),
        );
      }
    }
    out.push("");
  };
  section(
    "What you look for",
    items.filter((i) => i.group === "look"),
  );
  section(
    "What you skip",
    items.filter((i) => i.group === "skip"),
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
    const learning = await loadLearning(openStore(), repo);
    const items = memoryItems(learning);
    if (options.json) console.log(JSON.stringify(items, null, 2));
    else process.stdout.write(renderMemory(repo, items, shouldColor(process.stdout), learning.paused));
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
    .command("edit")
    .description("Rewrite one of your notes.")
    .argument("<id>", "the note's id, from `alden memory`")
    .argument("<text...>", "the new text")
    .option("--repo <owner/name>", "the repo (default: this clone's origin)")
    .action(async (id: string, words: string[], options: { repo?: string }) => {
      const repo = await repoFrom({ ...memory.opts(), ...options });
      try {
        if (!(await editNote(openStore(), repo, id, words.join(" ")))) {
          program.error(`No note called ${id} in ${repo}. \`alden memory\` lists the ids.`);
        }
      } catch (error) {
        program.error((error as Error).message);
      }
      console.log(`Updated ${id}.`);
    });

  for (const [name, action] of [
    ["exclude", "exclude"],
    ["include", "include"],
  ] as const) {
    memory
      .command(name)
      .description(
        action === "exclude"
          ? "Stop applying one of your notes to a folder or file: the model isn't told it for changes there."
          : "Apply one of your notes to a folder or file again.",
      )
      .argument("<id>", "the note's id, from `alden memory`")
      .argument("<path>", "a folder (e.g. app/api) or a file in the repo")
      .option("--repo <owner/name>", "the repo (default: this clone's origin)")
      .action(async (id: string, path: string, options: { repo?: string }) => {
        const repo = await repoFrom({ ...memory.opts(), ...options });
        let done: boolean;
        try {
          path = notePath(path);
          done = await scopeNote(openStore(), repo, id, path, action);
        } catch (error) {
          program.error((error as Error).message);
        }
        if (!done) {
          program.error(
            action === "exclude"
              ? `No note called ${id} in ${repo}. \`alden memory\` lists the ids.`
              : `Note ${id} in ${repo} isn't stopped under ${path}. \`alden memory\` lists where it is.`,
          );
        }
        console.log(
          action === "exclude"
            ? `Note ${id} no longer applies under ${path}. \`alden memory include ${id} ${path}\` takes that back.`
            : `Note ${id} applies under ${path} again.`,
        );
      });
  }

  memory
    .command("forget")
    .description("Forget a note, or something Alden learned (it starts learning that again from scratch).")
    .argument("[id]", "the id `alden memory` shows")
    .option("--all", "forget everything in this repo")
    .option("--repo <owner/name>", "the repo (default: this clone's origin)")
    .action(async (id: string | undefined, options: { repo?: string; all?: boolean }) => {
      const repo = await repoFrom({ ...memory.opts(), ...options });
      if (options.all) {
        const n = await forgetAll(openStore(), repo);
        console.log(`Forgot ${n} item${n === 1 ? "" : "s"} in ${repo}. \`alden memory restore <id>\` brings one back.`);
        return;
      }
      if (!id) program.error("Name an id from `alden memory`, or pass --all.");
      if (!(await forget(openStore(), repo, id))) {
        program.error(`Nothing called ${id} in ${repo}. \`alden memory\` lists the ids.`);
      }
      console.log(`Forgotten: ${id}. \`alden memory restore ${id}\` takes it back.`);
    });

  memory
    .command("restore")
    .description("Take back a forget.")
    .argument("<id>", "the id you forgot")
    .option("--repo <owner/name>", "the repo (default: this clone's origin)")
    .action(async (id: string, options: { repo?: string }) => {
      const repo = await repoFrom({ ...memory.opts(), ...options });
      if (!restore(openStore(), repo, id)) program.error(`Nothing called ${id} was forgotten in ${repo}.`);
      console.log(`Restored: ${id}.`);
    });

  for (const [name, on] of [
    ["pause", false],
    ["resume", true],
  ] as const) {
    memory
      .command(name)
      .description(
        on
          ? "Apply what Alden learned in this repo again."
          : "Stop applying what Alden learned in this repo; your reactions are still saved, and notes still apply.",
      )
      .option("--repo <owner/name>", "the repo (default: this clone's origin)")
      .action(async (options: { repo?: string }) => {
        const repo = await repoFrom({ ...memory.opts(), ...options });
        setLearning(openStore(), repo, on);
        console.log(on ? `Learning resumed in ${repo}.` : `Learning paused in ${repo}.`);
      });
  }
}
