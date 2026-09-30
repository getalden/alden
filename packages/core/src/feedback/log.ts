import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FEEDBACK_SCHEMA_VERSION,
  type FeedbackEvent,
  FeedbackEventSchema,
  type FeedbackInput,
  FeedbackInputSchema,
  type FeedbackItem,
  type FeedbackSummary,
  type FeedbackTarget,
} from "@alden/schema";
import { aldenHome } from "../config.js";

const targetKey = (t: FeedbackTarget) => (t.kind === "pr" ? `${t.repo}#${t.number}` : `local:${t.repo ?? ""}`);

/** One flag in one briefing: verdicts on it replace each other. */
export function feedbackItemKey(item: FeedbackItem): string {
  const where = item.anchor ? `${item.anchor.path}:${item.anchor.line ?? ""}` : "";
  return [item.placement, item.source, item.checkId ?? "", item.title, where].join("|");
}

const briefingKey = (e: FeedbackEvent) => `${targetKey(e.target)}@${e.briefingAt}`;

/**
 * Feedback, one append-only JSON-lines file per month in `~/.alden/feedback`. Nothing is sent anywhere; a design
 * partner shares it with `alden feedback --export`.
 */
export class FeedbackLog {
  constructor(private readonly dir: string = join(aldenHome(), "feedback")) {}

  /** Records an event from a front end, after checking its shape. */
  async add(input: FeedbackInput | unknown, now: Date = new Date()): Promise<FeedbackEvent> {
    const parsed = FeedbackInputSchema.parse(input);
    const event = FeedbackEventSchema.parse({
      ...parsed,
      schemaVersion: FEEDBACK_SCHEMA_VERSION,
      id: randomUUID(),
      at: now.toISOString(),
    });
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, `${event.at.slice(0, 7)}.jsonl`), `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  /** Every event, oldest first. Lines that don't parse, or fail the schema, are skipped. */
  async events(): Promise<FeedbackEvent[]> {
    let files: string[];
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith(".jsonl")).sort();
    } catch {
      return [];
    }
    const out: FeedbackEvent[] = [];
    for (const file of files) {
      const text = await readFile(join(this.dir, file), "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = FeedbackEventSchema.safeParse(JSON.parse(line));
          if (parsed.success) out.push(parsed.data);
        } catch {
          // a line cut short by a crash
        }
      }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  async summary(): Promise<FeedbackSummary> {
    return summarizeFeedback(await this.events());
  }
}

/** The numbers the gate needs: the latest verdict per flag wins, and "clear" takes one back. */
export function summarizeFeedback(events: FeedbackEvent[]): FeedbackSummary {
  const latest = new Map<string, Extract<FeedbackEvent, { kind: "verdict" }>>();
  const briefings = new Set<string>();
  let missed = 0;
  for (const event of events) {
    briefings.add(briefingKey(event));
    if (event.kind === "missed") missed++;
    else latest.set(`${briefingKey(event)}|${feedbackItemKey(event.item)}`, event);
  }

  const counts = () => ({ agree: 0, notNeeded: 0 });
  const summary: FeedbackSummary = {
    verdicts: 0,
    agree: 0,
    notNeeded: 0,
    eyesAgreeRate: null,
    eyes: counts(),
    modelFindings: counts(),
    bySource: { check: counts(), llm: counts() },
    byCheck: {},
    missed,
    briefings: briefings.size,
    since: events[0]?.at ?? null,
  };
  for (const { item, verdict } of latest.values()) {
    if (verdict === "clear") continue;
    const field = verdict === "agree" ? "agree" : "notNeeded";
    summary.verdicts++;
    summary[field]++;
    summary[item.placement === "eyes" ? "eyes" : "modelFindings"][field]++;
    summary.bySource[item.source][field]++;
    const byCheck = item.checkId ?? (item.source === "llm" ? "model" : "other");
    summary.byCheck[byCheck] ??= counts();
    (summary.byCheck[byCheck] as { agree: number; notNeeded: number })[field]++;
  }
  const eyesTotal = summary.eyes.agree + summary.eyes.notNeeded;
  summary.eyesAgreeRate = eyesTotal === 0 ? null : summary.eyes.agree / eyesTotal;
  return summary;
}

const hashed = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * Events fit to share outside the company: repo names hashed (consistently, so one repo's events still group), and
 * no titles, paths, lines or notes. What stays is what the gate needs: which check, which verdict, when, which model.
 */
export function redactFeedback(events: FeedbackEvent[]): FeedbackEvent[] {
  return events.map((event) => {
    const target: FeedbackTarget =
      event.target.kind === "pr"
        ? { kind: "pr", repo: `repo-${hashed(event.target.repo)}`, number: event.target.number }
        : { kind: "local", repo: event.target.repo ? `repo-${hashed(event.target.repo)}` : null };
    if (event.kind === "missed") {
      const { anchor: _anchor, ...rest } = event;
      return { ...rest, target, note: "(redacted)" };
    }
    const { anchor: _anchor, ...item } = event.item;
    return { ...event, target, item: { ...item, title: "(redacted)" } };
  });
}
