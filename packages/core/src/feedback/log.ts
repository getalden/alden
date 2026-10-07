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
  type ReviewSignalEvent,
  ReviewSignalEventSchema,
  type ReviewSignalInput,
  ReviewSignalInputSchema,
  type ReviewSignalKind,
  ReviewSignalKindSchema,
} from "@alden/schema";
import { loadConfig } from "../config.js";
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
   * Records review signals (see `ReviewSignalEventSchema`), after checking their shape. All or none. A signal given an
   * `id` (an outcome's, derived from what it's about) is recorded at most once: one whose id is already in the log is
   * left out. Returns the signals newly recorded.
   */
  addSignals(inputs: (ReviewSignalInput | unknown)[], now: Date = new Date()): ReviewSignalEvent[] {
    const events = inputs.map((input) => {
      const parsed = ReviewSignalInputSchema.parse(input);
      return ReviewSignalEventSchema.parse({
        ...parsed,
        schemaVersion: FEEDBACK_SCHEMA_VERSION,
        id: parsed.id ?? randomUUID(),
        type: "review_signal",
        at: parsed.at ?? now.toISOString(),
      });
    });
    const store = storeFrom(this.source);
    const recorded: ReviewSignalEvent[] = [];
    store.transaction(() => {
      const ids = new Set<string>();
      for (const event of events) {
        if (ids.has(event.id) || store.get("SELECT 1 AS found FROM events WHERE id = ?", event.id)) continue;
        ids.add(event.id);
        store.addEvent({ id: event.id, at: event.at, type: "review_signal", repo: event.repo, body: event });
        recorded.push(event);
      }
    });
    return recorded;
  }

  /**
   * Every review signal, oldest first, optionally for one repo and since a time. Signals that fail the schema are
   * skipped.
   */
  signals(repo?: string, since?: string): ReviewSignalEvent[] {
    return storeFrom(this.source)
      .events<unknown>("review_signal", {
        ...(repo !== undefined ? { repo } : {}),
        ...(since !== undefined ? { since } : {}),
      })
      .flatMap((raw) => {
        const parsed = ReviewSignalEventSchema.safeParse(raw);
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
    return summarizeFeedback(await this.events(), this.signals());
  }

  /** Every event, fit to share: see `redactFeedback`. Repo names are hashed with this install's own salt. */
  async redacted(): Promise<FeedbackEvent[]> {
    const store = storeFrom(this.source);
    return redactFeedback(await this.events(), (repo) => `repo-${repoHash(repo, store).slice(0, 12)}`);
  }

  /** Every review signal, fit to share: repo names hashed as in `redacted`, and no paths or lines. */
  redactedSignals(): ReviewSignalEvent[] {
    const store = storeFrom(this.source);
    return this.signals().map(({ path: _path, line: _line, ...signal }) => ({
      ...signal,
      repo: `repo-${repoHash(signal.repo, store).slice(0, 12)}`,
    }));
  }
}

/**
 * Records what a review (or, with `source: "outcome"`, what the author did with it) taught Alden, unless
 * `learning.fromReviews` is off: `enabled` says so, or your user config is read. A signal with an `id` is recorded at
 * most once (see `FeedbackLog.addSignals`). Returns what was newly recorded.
 */
export async function recordReviewSignals(
  signals: (ReviewSignalInput | unknown)[],
  options: { store?: StoreSource; enabled?: boolean; now?: Date } = {},
): Promise<ReviewSignalEvent[]> {
  const enabled = options.enabled ?? (await loadConfig()).learning.fromReviews;
  if (!enabled || signals.length === 0) return [];
  return new FeedbackLog(options.store).addSignals(signals, options.now);
}

/** How many review signals of each kind. */
export function signalCounts(signals: Pick<ReviewSignalEvent, "signal">[]): Record<ReviewSignalKind, number> {
  const counts = Object.fromEntries(ReviewSignalKindSchema.options.map((k) => [k, 0])) as Record<
    ReviewSignalKind,
    number
  >;
  for (const { signal } of signals) counts[signal]++;
  return counts;
}

/**
 * The numbers the gate needs: the latest verdict per flag wins, and "clear" takes one back. Review signals are counted
 * apart, by kind, so the useful rate stays what you clicked.
 */
export function summarizeFeedback(events: FeedbackEvent[], signals: ReviewSignalEvent[] = []): FeedbackSummary {
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
    reviewSignals: signalCounts(signals),
    reviews: new Set(signals.filter((s) => s.source === "review").map((s) => `${s.repo.toLowerCase()}#${s.pr}@${s.at}`))
      .size,
    briefings: briefings.size,
    since: [events[0]?.at, signals[0]?.at].filter((at) => at !== undefined).sort()[0] ?? null,
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
