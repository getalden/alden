import { spawn } from "node:child_process";
import { JsonCache, markFollowUpsSeen, openStore, type QueueRow } from "@alden/core";
import type { Command } from "commander";
import { noteOpened } from "../learning.js";
import { parsePrRef } from "../pr-ref.js";

/** What `alden queue` last showed, so `alden open 3` opens the third row. */
export const LAST_QUEUE_KEY = "last-queue";
const LAST_QUEUE_MAX_AGE_MS = 24 * 3_600_000;

export interface LastQueue {
  urls: string[];
  /** Each row's learning features and unlearned rank, so opening one can teach Alden. Absent in older caches. */
  rows?: QueueRow[];
}

export function openInBrowser(url: string, fallback = `Couldn't open a browser. The PR is at ${url}`): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? // Not `cmd /c start`: cmd would treat & or | in the URL as its own syntax.
          ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => console.log(fallback));
  child.unref();
}

/** You opened a PR: what happened on it since your review is seen, and it leaves the queue's Your turn. */
export function noteFollowUpsSeen(repo: string, number: number): void {
  try {
    markFollowUpsSeen(openStore(), repo, number);
  } catch {
    // the database is locked or damaged: opening the PR still works
  }
}

export function registerOpenCommand(program: Command): void {
  program
    .command("open")
    .description("Open a PR in the browser: by its # in your last `alden queue`, or by name (one under Your turn).")
    .argument("<pr>", "the PR's number in the list, e.g. 3, or owner/repo#123, or a PR URL")
    .action(async (rankText: string) => {
      if (!/^#?\d+$/.test(rankText.trim())) {
        let ref: { repo: string; number: number };
        try {
          ref = parsePrRef(rankText, undefined);
        } catch (error) {
          program.error((error as Error).message);
        }
        const url = `https://github.com/${ref.repo}/pull/${ref.number}`;
        console.log(`Opening ${url}`);
        openInBrowser(url);
        noteFollowUpsSeen(ref.repo, ref.number);
        return;
      }
      const rank = Number.parseInt(rankText.trim().replace("#", ""), 10);
      if (!Number.isInteger(rank) || rank < 1 || String(rank) !== rankText.trim().replace("#", "")) {
        program.error(`"${rankText}" isn't a # from the list. Use the number on the left, e.g. \`alden open 3\`.`);
      }

      const last = await new JsonCache().get<LastQueue>(LAST_QUEUE_KEY, LAST_QUEUE_MAX_AGE_MS);
      if (!last) program.error("Run `alden queue` first, then open a PR by its #.");

      const url = last.urls[rank - 1];
      if (!url) {
        program.error(
          last.urls.length === 0
            ? "Your last queue was empty, so there's nothing to open."
            : `There's no #${rank}; your last queue had ${last.urls.length}.`,
        );
      }
      // The cache is a plain file; only ever hand the OS a web link.
      if (!url.startsWith("https://")) program.error(`Refusing to open ${url}: not an https link.`);

      console.log(`Opening ${url}`);
      openInBrowser(url);
      noteOpened(last.rows, url, "cli");
      const ref = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url);
      if (ref) noteFollowUpsSeen(ref[1] as string, Number(ref[2]));
    });
}
