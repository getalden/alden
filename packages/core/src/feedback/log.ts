import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  FEEDBACK_SCHEMA_VERSION,
  type FeedbackEvent,
  FeedbackEventSchema,
  type FeedbackInput,
  FeedbackInputSchema,
  type FeedbackItem,
  type FeedbackSummary,
  type FeedbackTarget,
  type ReviewSignal,
  ReviewSignalSchema,
} from "@alden/schema";
import { type StoreSource, storeFrom } from "../store/source.js";
import { repoHash } from "../telemetry/telemetry.js";

const targetKey = (t: FeedbackTarget) => (t.kind === "pr" ? `${t.repo}#${t.number}` : `local:${t.repo ?? ""}`);

/** One flag in one briefing: verdicts on it replace each other. */
export function feedbackItemKey(item: FeedbackItem): string {
  const where = item.anchor ? `${item.anchor.path}:${item.anchor.line ?? ""}` : "";
  return [item.placement, item.source, item.checkId ?? "", item.title, where].join("|");
}

const briefingKey = (e: FeedbackEvent) => `${targetKey(e.target)}@${e.briefingAt}`;

/**
 * Feedback, as append-only events in Alden's local database. Nothing is sent anywhere; a design partner shares it
 * with `alden feedback --export`.
 */
export class FeedbackLog {
  constructor(private readonly source?: StoreSource) {}

  /** Records an event from a front end, after checking its shape. */
  async add(input: FeedbackInput | unknown, now: Date = new Date()): Promise<FeedbackEvent> {
    const parsed = FeedbackInputSchema.parse(input);
    const event = FeedbackEventSchema.parse({
      ...parsed,
      schemaVersion: FEEDBACK_SCHEMA_VERSION,
      id: randomUUID(),
      at: now.toISOString(),
    });
    storeFrom(this.source).addEvent({
      id: event.id,
      at: event.at,
      type: "feedback",
      repo: event.target.repo,
      body: event,
    });
    return event;
  }

  /**
   * Records a review signal (see `ReviewSignalSchema`) as a "review_signal" event. With `id`, at most once: a second
   * signal with the same id is ignored. Returns whether it was new.
   */
  recordSignal(input: ReviewSignal, id: string = randomUUID()): boolean {
    const signal = ReviewSignalSchema.parse(input);
    const store = storeFrom(this.source);
    const before = store.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE id = ?", id)?.n ?? 0;
    store.addEvent({ id, at: signal.at, type: "review_signal", repo: signal.repo, body: signal });
    return Number(before) === 0;
  }

  /** Review signals, oldest first, optionally for one repo and since a time. Ones that fail the schema are skipped. */
  signals(options: { repo?: string; since?: string } = {}): ReviewSignal[] {
    return storeFrom(this.source)
      .events<unknown>("review_signal", options)
      .flatMap((raw) => {
        const parsed = ReviewSignalSchema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      });
  }

  /** Every event, oldest first, optionally for one repo. Events that fail the schema are skipped. */
  async events(repo?: string): Promise<FeedbackEvent[]> {
    return storeFrom(this.source)
      .events<unknown>("feedback", repo === undefined ? {} : { repo })
      .flatMap((raw) => {
        const parsed = FeedbackEventSchema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      });
  }

  async summary(): Promise<FeedbackSummary> {
    return summarizeFeedback(await this.events());
  }

  /** Every event, fit to share: see `redactFeedback`. Repo names are hashed with this install's own salt. */
  async redacted(): Promise<FeedbackEvent[]> {
    const store = storeFrom(this.source);
    return redactFeedback(await this.events(), (repo) => `repo-${repoHash(repo, store).slice(0, 12)}`);
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
    dismissed: 0,
    missed,
    briefings: briefings.size,
    since: events[0]?.at ?? null,
  };
  for (const { item, verdict } of latest.values()) {
    if (verdict === "clear") continue;
    if (verdict === "dismiss") {
      summary.dismissed++;
      continue;
    }
    const field = verdict === "agree" ? "agree" : "notNeeded";
    summary.verdicts++;
    summary[field]++;
    if (item.placement !== "check") summary[item.placement === "eyes" ? "eyes" : "modelFindings"][field]++;
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
 * Events fit to share outside the company: repo names replaced by `repoCode` (consistently, so one repo's events still
 * group; `FeedbackLog.redacted` uses a hash salted per install, so a known repo name can't be matched), and no titles,
 * paths, lines or notes. What stays is what the gate needs: which check, which verdict, when, which model.
 */
export function redactFeedback(events: FeedbackEvent[], repoCode?: (repo: string) => string): FeedbackEvent[] {
  // Each flag gets a code in place of its title and place, so two flags of one check stay two (the latest verdict per
  // flag counts). The salt is new for every export and never written down, so codes can't be matched to guesses.
  const salt = randomBytes(16).toString("hex");
  const code = (item: FeedbackItem) => hashed(`${salt}|${feedbackItemKey(item)}`);
  const repoOf = repoCode ?? ((repo: string) => `repo-${hashed(`${salt}|repo|${repo.toLowerCase()}`)}`);
  return events.map((event) => {
    const target: FeedbackTarget =
      event.target.kind === "pr"
        ? { kind: "pr", repo: repoOf(event.target.repo), number: event.target.number }
        : { kind: "local", repo: event.target.repo ? repoOf(event.target.repo) : null };
    if (event.kind === "missed") {
      const { anchor: _anchor, ...rest } = event;
      return { ...rest, target, note: "(redacted)" };
    }
    const { anchor: _anchor, ...item } = event.item;
    return { ...event, target, item: { ...item, title: `(redacted ${code(event.item)})` } };
  });
}
