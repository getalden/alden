import { randomUUID } from "node:crypto";
import {
  type FeedbackEvent,
  type FeedbackItem,
  MEMORY_SCHEMA_VERSION,
  type MemoryEvent,
  MemoryEventSchema,
  type MemoryItem,
  type OpenEvent,
  OpenEventSchema,
  type PullRequestFacts,
} from "@alden/schema";
import { FeedbackLog } from "../feedback/log.js";
import { fileKind, isLockfile, sensitiveMatcher } from "../queue/files.js";
import type { AldenStore } from "../store/db.js";

/**
 * What Alden learns from one reviewer in one repo, and how it uses it. Every rule is a plain count anyone can check,
 * and every effect is shown where it applies ("ranked higher: …", "hidden because …"), so nothing changes silently.
 */

/** Verdicts or opens it takes before Alden acts on a pattern. */
export const MIN_EVIDENCE = 3;
/** How one-sided verdicts must be before a check moves: three to one. */
const CHECK_RATIO = 0.75;
/** How often PRs with a feature must be opened ahead of their rank. */
const OPEN_RATIO = 0.6;
/** Opens older than this stop counting, so the ranking follows what you care about now. */
const OPEN_WINDOW_DAYS = 90;
/** Points one learned feature adds to a PR's score: about one step of waiting. */
export const OPEN_BOOST = 1.5;
/** A PR gets at most this much from learning, so it can't outrank a PR that's blocking someone. */
export const MAX_OPEN_BOOST = 3;
/** Checks Alden never quietens, however often they're marked not needed. */
const NEVER_QUIETENED = new Set(["secrets.likely"]);

/** What a check's flags are called in a sentence. */
const CHECK_NAMES: Record<string, string> = {
  "tests.missing": "untested-change flags",
  "migrations.changed": "migration flags",
  "config.changed": "config-change flags",
  "paths.sensitive": "sensitive-path flags",
  "dependencies.changed": "dependency flags",
  "secrets.likely": "possible-secret flags",
  "signatures.changed": "public API change flags",
  "callers.outside": "flags about callers outside the diff",
};
export const checkName = (id: string) => CHECK_NAMES[id] ?? `${id} flags`;

/** A check whose flags you consistently agree with, or consistently don't need. */
export interface CheckLesson {
  id: string;
  checkId: string;
  direction: "up" | "down";
  agree: number;
  notNeeded: number;
  since: string;
}

/** A kind of PR you open ahead of where Alden ranked it. */
export interface OpenLesson {
  id: string;
  feature: string;
  opens: number;
  jumps: number;
  since: string;
}

export interface Note {
  id: string;
  text: string;
  since: string;
}

export interface Learning {
  repo: string;
  checks: Map<string, CheckLesson>;
  opens: OpenLesson[];
  /** Places you marked "not needed", per PR (or local changes), so a re-review doesn't raise them again. */
  dismissed: Map<string, string>;
  notes: Note[];
}

// --- Features ---------------------------------------------------------------------------------------------------

/** The shortest leading directory that is itself sensitive, e.g. "db/migrations/" rather than the file. */
export function sensitiveDir(path: string, matches: (p: string) => boolean): string {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = `${parts.slice(0, i).join("/")}/`;
    if (matches(`${dir}x`)) return dir;
  }
  return path;
}

/** What a PR is about, as learning features. Lockfiles are covered by "kind:dependency", not by name. */
export function prFeatures(pr: PullRequestFacts, sensitivePaths: string[]): string[] {
  const isSensitive = sensitiveMatcher(sensitivePaths);
  const features = new Set<string>();
  for (const file of pr.files) {
    if (isSensitive(file.path) && !isLockfile(file.path)) features.add(`path:${sensitiveDir(file.path, isSensitive)}`);
    if (fileKind(file.path) === "dependency") features.add("kind:dependency");
  }
  if (pr.author && !pr.authorIsBot) features.add(`author:${pr.author.toLowerCase()}`);
  for (const label of pr.labels) features.add(`label:${label.toLowerCase()}`);
  return [...features].sort();
}

/** "path:db/migrations/" → "PRs touching db/migrations/". */
export function describeFeature(feature: string): string {
  const [kind, ...rest] = feature.split(":");
  const value = rest.join(":");
  if (kind === "path") return `PRs touching ${value}`;
  if (kind === "author") return `@${value}'s PRs`;
  if (kind === "label") return `PRs labelled ${value}`;
  if (feature === "kind:dependency") return "dependency changes";
  return feature;
}

// --- Learning ---------------------------------------------------------------------------------------------------

const feedbackTargetKey = (e: FeedbackEvent) =>
  e.target.kind === "pr" ? `${e.target.repo.toLowerCase()}#${e.target.number}` : "local";

/** A flag across reviews of the same PR: its line can move as the code changes, so only the file counts. */
export function dismissKey(
  target: string,
  item: Pick<FeedbackItem, "source" | "checkId" | "title" | "anchor">,
): string {
  return [target, item.source, item.checkId ?? "", item.title, item.anchor?.path ?? ""].join("|");
}

export function learn(input: {
  repo: string;
  feedback: FeedbackEvent[];
  opens: OpenEvent[];
  memory: MemoryEvent[];
  now?: Date;
}): Learning {
  const now = input.now ?? new Date();
  // Forgetting a learned item wipes what it was learned from: only evidence after the forget counts.
  const forgotAt = new Map<string, string>();
  const notes = new Map<string, Note>();
  for (const event of input.memory) {
    if (event.action === "add") notes.set(event.item, { id: event.item, text: event.text, since: event.at });
    else {
      forgotAt.set(event.item, event.at);
      notes.delete(event.item);
    }
  }
  const after = (id: string, at: string) => !forgotAt.has(id) || at > (forgotAt.get(id) as string);

  // The latest verdict per flag per briefing, then per flag per PR for dismissals.
  const latest = new Map<string, Extract<FeedbackEvent, { kind: "verdict" }>>();
  const dismissedAt = new Map<string, Extract<FeedbackEvent, { kind: "verdict" }>>();
  for (const event of input.feedback) {
    if (event.kind !== "verdict") continue;
    const key = dismissKey(feedbackTargetKey(event), event.item);
    latest.set(`${event.briefingAt}|${key}`, event);
    dismissedAt.set(key, event);
  }
  const dismissed = new Map<string, string>();
  for (const [key, event] of dismissedAt) if (event.verdict === "not_needed") dismissed.set(key, event.at);

  const tallies = new Map<string, { agree: number; notNeeded: number; since: string }>();
  for (const event of latest.values()) {
    const checkId = event.item.source === "check" ? event.item.checkId : undefined;
    if (!checkId || event.verdict === "clear") continue;
    const tally = tallies.get(checkId) ?? { agree: 0, notNeeded: 0, since: event.at };
    // Count per direction, each after its own forget.
    if (event.verdict === "agree" && after(`check:${checkId}:up`, event.at)) tally.agree++;
    if (event.verdict === "not_needed" && after(`check:${checkId}:down`, event.at)) tally.notNeeded++;
    if (event.at < tally.since) tally.since = event.at;
    tallies.set(checkId, tally);
  }
  const checks = new Map<string, CheckLesson>();
  for (const [checkId, { agree, notNeeded, since }] of tallies) {
    const total = agree + notNeeded;
    if (agree >= MIN_EVIDENCE && agree / total >= CHECK_RATIO) {
      checks.set(checkId, { id: `check:${checkId}:up`, checkId, direction: "up", agree, notNeeded, since });
    } else if (notNeeded >= MIN_EVIDENCE && notNeeded / total >= CHECK_RATIO && !NEVER_QUIETENED.has(checkId)) {
      checks.set(checkId, { id: `check:${checkId}:down`, checkId, direction: "down", agree, notNeeded, since });
    }
  }

  const windowStart = new Date(now.getTime() - OPEN_WINDOW_DAYS * 86_400_000).toISOString();
  const byFeature = new Map<string, { opens: number; jumps: number; since: string }>();
  for (const open of input.opens) {
    if (open.at < windowStart || open.position < 0) continue;
    for (const feature of open.features) {
      if (!after(`open:${feature}`, open.at)) continue;
      const tally = byFeature.get(feature) ?? { opens: 0, jumps: 0, since: open.at };
      tally.opens++;
      if (open.position > 0) tally.jumps++;
      byFeature.set(feature, tally);
    }
  }
  const opens = [...byFeature]
    .filter(([, t]) => t.jumps >= MIN_EVIDENCE && t.jumps / t.opens >= OPEN_RATIO)
    .map(([feature, t]) => ({ id: `open:${feature}`, feature, ...t }))
    .sort((a, b) => b.jumps - a.jumps || a.feature.localeCompare(b.feature));

  return { repo: input.repo.toLowerCase(), checks, opens, dismissed, notes: [...notes.values()] };
}

/** Everything learned for `repo`, from the store. */
export async function loadLearning(store: AldenStore, repo: string, now: Date = new Date()): Promise<Learning> {
  return learn({
    repo,
    feedback: await new FeedbackLog(store).events(repo),
    opens: store.events<unknown>("open", { repo }).flatMap((raw) => {
      const parsed = OpenEventSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    }),
    memory: memoryEvents(store, repo),
    now,
  });
}

function memoryEvents(store: AldenStore, repo: string): MemoryEvent[] {
  return store.events<unknown>("memory", { repo }).flatMap((raw) => {
    const parsed = MemoryEventSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
}

// --- Using it ---------------------------------------------------------------------------------------------------

/** Points a PR gets from what you usually open first, and the reason to show. */
export function openBoost(learning: Learning | undefined, features: string[]): { points: number; reason?: string } {
  if (!learning) return { points: 0 };
  const matched = learning.opens.filter((lesson) => features.includes(lesson.feature));
  if (matched.length === 0) return { points: 0 };
  const first = matched[0] as OpenLesson;
  return {
    points: Math.min(MAX_OPEN_BOOST, matched.length * OPEN_BOOST),
    reason: `ranked higher: you usually open ${describeFeature(first.feature)} first`,
  };
}

/** The sentence for a check lesson, as a place to look shows it. */
export function checkReason(lesson: CheckLesson): string {
  const total = lesson.agree + lesson.notNeeded;
  return lesson.direction === "up"
    ? `You usually agree with ${checkName(lesson.checkId)} (${lesson.agree} of ${total})`
    : `You usually mark ${checkName(lesson.checkId)} not needed (${lesson.notNeeded} of ${total})`;
}

/** What Alden knows about you in a repo, as `alden memory` and the UI list it: your notes first. */
export function memoryItems(learning: Learning): MemoryItem[] {
  const repo = learning.repo;
  const notes: MemoryItem[] = learning.notes.map((n) => ({
    id: n.id,
    repo,
    source: "you",
    kind: "note",
    text: n.text,
    effect: "given to the model with every review",
    since: n.since,
  }));
  const checks: MemoryItem[] = [...learning.checks.values()].map((lesson) => ({
    id: lesson.id,
    repo,
    source: "learned",
    kind: "check",
    text:
      lesson.direction === "up"
        ? `You care about ${checkName(lesson.checkId)}`
        : `You usually don't need ${checkName(lesson.checkId)}`,
    evidence:
      lesson.direction === "up"
        ? `agreed ${lesson.agree} of ${lesson.agree + lesson.notNeeded} times`
        : `marked not needed ${lesson.notNeeded} of ${lesson.agree + lesson.notNeeded} times`,
    effect:
      lesson.direction === "up"
        ? "picked first among places to look"
        : "left out of places to look, unless high severity",
    since: lesson.since,
  }));
  const opens: MemoryItem[] = learning.opens.map((lesson) => ({
    id: lesson.id,
    repo,
    source: "learned",
    kind: "open",
    text: `You open ${describeFeature(lesson.feature)} first`,
    evidence: `opened ahead of their rank ${lesson.jumps} of ${lesson.opens} times`,
    effect: "ranked higher in your queue",
    since: lesson.since,
  }));
  return [...notes, ...checks, ...opens];
}

/** Notes and learned check preferences, as lines for the model's prompt. */
export function promptNotes(learning: Learning | undefined): string[] {
  if (!learning) return [];
  return [
    ...learning.notes.map((n) => n.text),
    ...[...learning.checks.values()]
      .filter((l) => l.direction === "up")
      .map((l) => `Cares about ${checkName(l.checkId).replace(/ flags$/, "")} issues.`),
  ];
}

// --- Writing ----------------------------------------------------------------------------------------------------

export function addNote(store: AldenStore, repo: string, text: string, now: Date = new Date()): MemoryEvent {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("A note needs some text.");
  if (trimmed.length > 500) throw new Error("Keep a note under 500 characters.");
  const event: MemoryEvent = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: randomUUID(),
    at: now.toISOString(),
    repo: repo.toLowerCase(),
    action: "add",
    item: `note:${randomUUID().slice(0, 8)}`,
    text: trimmed,
  };
  store.addEvent({ id: event.id, at: event.at, type: "memory", repo: event.repo, body: event });
  return event;
}

/** Forgets a note or a learned item. Returns false when `repo` has nothing by that id. */
export async function forget(store: AldenStore, repo: string, item: string, now: Date = new Date()): Promise<boolean> {
  const known = memoryItems(await loadLearning(store, repo, now)).some((m) => m.id === item);
  if (!known) return false;
  const event: MemoryEvent = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: randomUUID(),
    at: now.toISOString(),
    repo: repo.toLowerCase(),
    action: "forget",
    item,
  };
  store.addEvent({ id: event.id, at: event.at, type: "memory", repo: event.repo, body: event });
  return true;
}

/** How long one look at a PR counts as one open: reopening it the same day says nothing new. */
const REOPEN_HOURS = 12;

/**
 * One row of the queue as it was shown, for learning from what you open: its learning features, and its place in
 * the "needs you" lane ranked without anything learned (-1 in fast-track).
 */
export interface QueueRow {
  url: string;
  repo: string;
  number: number;
  features: string[];
  base: number;
}

/**
 * Records that you opened `row`. Its position counts only rows you haven't opened lately, so working down the list
 * reads as "in order" and jumping past PRs reads as "this matters more to me". Returns false for a reopen.
 */
export function recordOpen(
  store: AldenStore,
  rows: QueueRow[],
  row: QueueRow,
  via: OpenEvent["via"],
  now: Date = new Date(),
): boolean {
  const since = new Date(now.getTime() - REOPEN_HOURS * 3_600_000).toISOString();
  const recent = store.all<{ repo: string; body: string }>(
    "SELECT repo, body FROM events WHERE type = 'open' AND at >= ?",
    since,
  );
  const opened = new Set(
    recent.flatMap((r) => {
      try {
        const e = JSON.parse(r.body) as OpenEvent;
        return [`${e.repo.toLowerCase()}#${e.number}`];
      } catch {
        return [];
      }
    }),
  );
  const key = (r: Pick<QueueRow, "repo" | "number">) => `${r.repo.toLowerCase()}#${r.number}`;
  if (opened.has(key(row))) return false;
  const position =
    row.base < 0 ? -1 : rows.filter((r) => r.base >= 0 && r.base < row.base && !opened.has(key(r))).length;
  const event: OpenEvent = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: randomUUID(),
    at: now.toISOString(),
    repo: row.repo.toLowerCase(),
    number: row.number,
    position,
    features: row.features,
    via,
  };
  store.addEvent({ id: event.id, at: event.at, type: "open", repo: event.repo, body: event });
  return true;
}
