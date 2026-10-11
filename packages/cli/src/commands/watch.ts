import {
  clearWatch,
  JsonCache,
  listWatches,
  loadConfig,
  openStore,
  prWatch,
  setWatch,
  type WatchOverride,
} from "@alden/core";
import type { FollowUpLevel } from "@alden/schema";
import type { Command } from "commander";
import { parsePrRef } from "../pr-ref.js";
import { paint, shouldColor, stripControlDeep } from "../render/style.js";
import { LAST_QUEUE_KEY, type LastQueue } from "./open.js";

/** Each level in words, as `alden watch` and the bell in the UI say it. */
export const LEVEL_TEXT: Record<FollowUpLevel, string> = {
  off: "off: no notifications",
  rereview: "re-review only: when you're asked to review again",
  "your-turn": "your turn: a re-review, or when every comment you left is resolved or answered",
  "every-reply": "every reply: each reply, resolve, re-review and push that outdates your comment",
};

interface WatchFlags {
  off?: boolean;
  rereview?: boolean;
  yourTurn?: boolean;
  everyReply?: boolean;
  default?: boolean;
  json?: boolean;
}

/** The level the flags ask for: a level, null for `--default`, undefined for none. Throws on more than one. */
export function levelFromFlags(flags: WatchFlags): FollowUpLevel | null | undefined {
  const chosen = (
    [
      ["off", flags.off],
      ["rereview", flags.rereview],
      ["your-turn", flags.yourTurn],
      ["every-reply", flags.everyReply],
      ["default", flags.default],
    ] as const
  ).filter(([, on]) => on);
  if (chosen.length > 1) throw new Error("Pick one of --off, --rereview, --your-turn, --every-reply or --default.");
  const [level] = chosen[0] ?? [];
  return level === "default" ? null : level;
}

/** Every PR with its own level, and the global one, for `alden watch` with no PR. */
export function renderWatches(untrusted: WatchOverride[], global: FollowUpLevel, color: boolean): string {
  const watches = stripControlDeep(untrusted);
  const out = [`${paint("Follow-ups:", "bold", color)} ${LEVEL_TEXT[global]} (notifications.followUps)`];
  if (watches.length === 0) {
    out.push("No PR has its own level. Give one with: alden watch owner/repo#12 --every-reply");
  } else {
    out.push("", paint("PRs with their own level", "bold", color));
    const width = Math.max(...watches.map((w) => w.pr.length));
    for (const w of watches) out.push(`  ${w.pr.padEnd(width)}  ${LEVEL_TEXT[w.level]}`);
    out.push(
      "",
      paint(
        "Back to the global level: alden watch <pr> --default. Ends when the PR is merged or closed.",
        "dim",
        color,
      ),
    );
  }
  return `${out.join("\n")}\n`;
}

export function registerWatchCommand(program: Command): void {
  program
    .command("watch")
    .description(
      "How much the desktop app tells you about a PR you reviewed: replies, resolves and re-review requests. Without a PR, lists the PRs with their own level.",
    )
    .argument("[pr]", "a PR URL, owner/repo#123, or a # from `alden queue`")
    .option("--off", "no notifications for this PR")
    .option("--rereview", "only when you're asked to review it again")
    .option("--your-turn", "a re-review, or when every comment you left is resolved or answered")
    .option("--every-reply", "each reply, resolve, re-review and push that outdates your comment")
    .option("--default", "back to the global level (notifications.followUps)")
    .option("--json", "print the result as JSON")
    .action(async (pr: string | undefined, flags: WatchFlags) => {
      let level: FollowUpLevel | null | undefined;
      try {
        level = levelFromFlags(flags);
      } catch (error) {
        program.error((error as Error).message);
      }
      const global = (await loadConfig()).notifications.followUps;
      const store = openStore();
      if (pr === undefined) {
        if (level !== undefined) program.error("Which PR? alden watch owner/repo#12 --every-reply");
        const watches = listWatches(store);
        if (flags.json) console.log(JSON.stringify({ global, prs: watches }, null, 2));
        else process.stdout.write(renderWatches(watches, global, shouldColor(process.stdout)));
        return;
      }
      const last = await new JsonCache().get<LastQueue>(LAST_QUEUE_KEY, 24 * 3_600_000);
      let ref: { repo: string; number: number };
      try {
        ref = parsePrRef(pr, last?.urls);
      } catch (error) {
        program.error((error as Error).message);
      }
      if (level === null) clearWatch(store, ref.repo, ref.number);
      else if (level !== undefined) setWatch(store, ref.repo, ref.number, level);
      const watch = prWatch(store, ref.repo, ref.number, global);
      if (flags.json) {
        console.log(JSON.stringify(watch, null, 2));
        return;
      }
      const how = watch.override ? "its own level" : "the global level";
      console.log(`${watch.pr}: ${LEVEL_TEXT[watch.level]} (${how}).`);
      if (watch.override && level !== undefined) {
        console.log("It goes back to the global level when the PR is merged or closed.");
      }
    });
}
