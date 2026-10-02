import { spawn } from "node:child_process";
import { JsonCache, type QueueRow } from "@alden/core";
import type { Command } from "commander";
import { noteOpened } from "../learning.js";

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

export function registerOpenCommand(program: Command): void {
  program
    .command("open")
    .description("Open a PR from your last `alden queue` in the browser, by its # in that list.")
    .argument("<rank>", "the PR's number in the list, e.g. 3")
    .action(async (rankText: string) => {
      const rank = Number.parseInt(rankText, 10);
      if (!Number.isInteger(rank) || rank < 1 || String(rank) !== rankText.trim()) {
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
    });
}
