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
  type ReactionEvent,
  ReactionEventSchema,
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
/** How often PRs with a feature must be opened ahead of their rank (or marked useful) to rank higher. */
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

/**
 * A kind of PR that ranks higher (you open it ahead of its rank, or mark it useful) or lower (you mark it not
 * useful). Learned per feature: a sensitive directory, an author, a label, dependency changes.
 */
export interface QueueLesson {
  id: string;
  feature: string;
  direction: "up" | "down";
  /** Up: opens ahead of rank. Down: always 0. */
  jumps: number;
  /** Rows marked useful (up) or not useful (down). */
  reactions: number;
  /** Everything counted for this direction's ratio. */
  total: number;
  since: string;
}

export interface Note {
  id: string;
  text: string;
  since: string;
}

export interface Learning {
  repo: string;
  /** Learning paused: what was learned is listed but not applied. Notes and dismissals still apply. */
  paused: boolean;
  checks: Map<string, CheckLesson>;
  queue: QueueLesson[];
  /** Places you dismissed, per PR (or local changes), so a re-review doesn't raise them again. */
  dismissed: Map<string, string>;
  /** PRs dismissed from the queue ("owner/repo#n", lowercased) and their updatedAt then. */
  dismissedPrs: Map<string, string>;
  /** Row reactions in force, by PR, so the UI can show them. */
  reactions: Map<string, ReactionEvent["reaction"]>;
  notes: Note[];
  /** Forgotten notes, kept so a forget can be undone. */
  forgottenNotes: Map<string, Note>;
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
  reactions?: ReactionEvent[];
  now?: Date;
}): Learning {
  const now = input.now ?? new Date();
  // Forgetting a learned item wipes what it was learned from: only evidence after the forget counts. Restoring it
  // takes the forget back.
  const forgotAt = new Map<string, string>();
  const notes = new Map<string, Note>();
  const forgottenNotes = new Map<string, Note>();
  let paused = false;
  for (const event of input.memory) {
    switch (event.action) {
      case "add":
        notes.set(event.item, { id: event.item, text: event.text, since: event.at });
        break;
      case "edit": {
        const note = notes.get(event.item);
        if (note) notes.set(event.item, { ...note, text: event.text });
        break;
      }
      case "forget": {
        forgotAt.set(event.item, event.at);
        const note = notes.get(event.item);
        if (note) forgottenNotes.set(event.item, note);
        notes.delete(event.item);
        break;
      }
      case "restore": {
        forgotAt.delete(event.item);
        const note = forgottenNotes.get(event.item);
        if (note) notes.set(event.item, note);
        forgottenNotes.delete(event.item);
        break;
      }
      case "pause":
        paused = true;
        break;
      case "resume":
        paused = false;
        break;
    }
  }
  const after = (id: string, at: string) => !forgotAt.has(id) || at > (forgotAt.get(id) as string);

  // The latest verdict per flag per briefing, then per flag per PR for dismissals.
  const latest = new Map<string, Extract<FeedbackEvent, { kind: "verdict" }>>();
  const latestOnPr = new Map<string, Extract<FeedbackEvent, { kind: "verdict" }>>();
  for (const event of input.feedback) {
    if (event.kind !== "verdict") continue;
    const key = dismissKey(feedbackTargetKey(event), event.item);
    latest.set(`${event.briefingAt}|${key}|${event.item.placement}`, event);
    latestOnPr.set(key, event);
  }
  const dismissed = new Map<string, string>();
  for (const [key, event] of latestOnPr) if (event.verdict === "dismiss") dismissed.set(key, event.at);

  const tallies = new Map<string, { agree: number; notNeeded: number; since: string }>();
  for (const event of latest.values()) {
    const checkId = event.item.source === "check" ? event.item.checkId : undefined;
    if (!checkId || (event.verdict !== "agree" && event.verdict !== "not_needed")) continue;
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

  // Row reactions: the latest per PR is in force.
  const reactionByPr = new Map<string, ReactionEvent>();
  for (const r of input.reactions ?? []) reactionByPr.set(`${r.repo.toLowerCase()}#${r.number}`, r);
  const reactions = new Map<string, ReactionEvent["reaction"]>();
  const dismissedPrs = new Map<string, string>();
  for (const [key, r] of reactionByPr) {
    if (r.reaction === "clear") continue;
    reactions.set(key, r.reaction);
    if (r.reaction === "dismiss") dismissedPrs.set(key, r.updatedAt);
  }

  const windowStart = new Date(now.getTime() - OPEN_WINDOW_DAYS * 86_400_000).toISOString();
  type Tally = { opens: number; jumps: number; ups: number; downs: number; upSince?: string; downSince?: string };
  const byFeature = new Map<string, Tally>();
  const tally = (feature: string) => {
    const t = byFeature.get(feature) ?? { opens: 0, jumps: 0, ups: 0, downs: 0 };
    byFeature.set(feature, t);
    return t;
  };
  const earliest = (a: string | undefined, b: string) => (a && a < b ? a : b);
  for (const open of input.opens) {
    if (open.at < windowStart || open.position < 0) continue;
    for (const feature of open.features) {
      if (!after(`queue:${feature}:up`, open.at)) continue;
      const t = tally(feature);
      t.opens++;
      if (open.position > 0) {
        t.jumps++;
        t.upSince = earliest(t.upSince, open.at);
      }
    }
  }
  for (const r of reactionByPr.values()) {
    if (r.at < windowStart || (r.reaction !== "up" && r.reaction !== "down")) continue;
    for (const feature of r.features) {
      const t = tally(feature);
      if (r.reaction === "up" && after(`queue:${feature}:up`, r.at)) {
        t.ups++;
        t.upSince = earliest(t.upSince, r.at);
      }
      if (r.reaction === "down" && after(`queue:${feature}:down`, r.at)) {
        t.downs++;
        t.downSince = earliest(t.downSince, r.at);
      }
    }
  }
  const queue: QueueLesson[] = [];
  for (const [feature, t] of byFeature) {
    const up = t.jumps + t.ups;
    const upTotal = t.opens + t.ups + t.downs;
    if (up >= MIN_EVIDENCE && up / upTotal >= OPEN_RATIO && t.upSince) {
      queue.push({
        id: `queue:${feature}:up`,
        feature,
        direction: "up",
        jumps: t.jumps,
        reactions: t.ups,
        total: upTotal,
        since: t.upSince,
      });
    } else if (t.downs >= MIN_EVIDENCE && t.downs / (t.downs + up) >= CHECK_RATIO && t.downSince) {
      queue.push({
        id: `queue:${feature}:down`,
        feature,
        direction: "down",
        jumps: 0,
        reactions: t.downs,
        total: t.downs + up,
        since: t.downSince,
      });
    }
  }
  queue.sort((a, b) => b.jumps + b.reactions - (a.jumps + a.reactions) || a.feature.localeCompare(b.feature));

  return {
    repo: input.repo.toLowerCase(),
    paused,
    checks,
    queue,
    dismissed,
    dismissedPrs,
    reactions,
    notes: [...notes.values()],
    forgottenNotes,
  };
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
    reactions: store.events<unknown>("reaction", { repo }).flatMap((raw) => {
      const parsed = ReactionEventSchema.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    }),
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

/** Points a PR gets or loses from how you treat PRs like it, and the reason to show. Nothing while paused. */
export function queueBoost(learning: Learning | undefined, features: string[]): { points: number; reason?: string } {
  if (!learning || learning.paused) return { points: 0 };
  const matched = learning.queue.filter((lesson) => features.includes(lesson.feature));
  if (matched.length === 0) return { points: 0 };
  const raw = matched.reduce((sum, l) => sum + (l.direction === "up" ? OPEN_BOOST : -OPEN_BOOST), 0);
  const points = Math.max(-MAX_OPEN_BOOST, Math.min(MAX_OPEN_BOOST, raw));
  if (points === 0) return { points: 0 };
  const lead = matched.find((l) => (points > 0 ? l.direction === "up" : l.direction === "down")) as QueueLesson;
  return { points, reason: queueReason(lead) };
}

/** "ranked higher: you usually open PRs touching db/ first", "ranked lower: you marked 4 PRs labelled docs not useful". */
export function queueReason(lesson: QueueLesson): string {
  const what = describeFeature(lesson.feature);
  if (lesson.direction === "down") return `ranked lower: you marked ${lesson.reactions} ${what} not useful`;
  return lesson.jumps >= lesson.reactions
    ? `ranked higher: you usually open ${what} first`
    : `ranked higher: you marked ${lesson.reactions} ${what} useful`;
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
    group: "look",
    text: n.text,
    effect: "Given to the model with every review of this repo.",
    since: n.since,
  }));
  const checks: MemoryItem[] = [...learning.checks.values()].map((lesson) => {
    const total = lesson.agree + lesson.notNeeded;
    const up = lesson.direction === "up";
    return {
      id: lesson.id,
      repo,
      source: "learned",
      kind: "check",
      group: up ? "look" : "skip",
      text: up ? `You care about ${checkName(lesson.checkId)}` : `You usually don't need ${checkName(lesson.checkId)}`,
      evidence: up
        ? `you marked ${lesson.agree} of ${total} useful`
        : `you marked ${lesson.notNeeded} of ${total} not useful`,
      examples: total,
      effect: up
        ? "Picked first among the places to look, and the model is told you care."
        : "Left out of the places to look, unless high severity. The briefing says what it hid.",
      since: lesson.since,
    };
  });
  const queue: MemoryItem[] = learning.queue.map((lesson) => {
    const up = lesson.direction === "up";
    const what = describeFeature(lesson.feature);
    const evidence = up
      ? [
          lesson.jumps > 0 && `opened ahead of their rank ${lesson.jumps} times`,
          lesson.reactions > 0 && `marked useful ${lesson.reactions} times`,
        ]
          .filter(Boolean)
          .join(", ")
      : `marked not useful ${lesson.reactions} times`;
    return {
      id: lesson.id,
      repo,
      source: "learned",
      kind: "queue",
      group: up ? "look" : "skip",
      text: up ? `You look at ${what} first` : `You skip ${what}`,
      evidence,
      examples: lesson.jumps + lesson.reactions,
      effect: up ? "Ranked higher in your queue." : "Ranked lower in your queue.",
      since: lesson.since,
    };
  });
  return [...notes, ...checks, ...queue];
}

/** Every repo Alden knows something about, most recently changed first, with how much and whether it's paused. */
export async function memoryRepos(
  store: AldenStore,
  now: Date = new Date(),
): Promise<{ repo: string; items: number; lastChange: string; paused: boolean }[]> {
  const rows = store.all<{ repo: string; last: string }>(
    "SELECT repo, MAX(at) AS last FROM events WHERE repo IS NOT NULL GROUP BY repo ORDER BY last DESC",
  );
  const out = [];
  for (const row of rows) {
    if (row.repo.startsWith("repo-")) continue; // redacted imports
    const learning = await loadLearning(store, row.repo, now);
    out.push({ repo: row.repo, items: memoryItems(learning).length, lastChange: row.last, paused: learning.paused });
  }
  return out;
}

/** Notes and learned check preferences, as lines for the model's prompt. */
export function promptNotes(learning: Learning | undefined): string[] {
  if (!learning) return [];
  return [
    ...learning.notes.map((n) => n.text),
    ...[...(learning.paused ? new Map<string, CheckLesson>() : learning.checks).values()]
      .filter((l) => l.direction === "up")
      .map((l) => `Cares about ${checkName(l.checkId).replace(/ flags$/, "")} issues.`),
  ];
}

// --- Writing ----------------------------------------------------------------------------------------------------

export function addNote(
  store: AldenStore,
  repo: string,
  text: string,
  now: Date = new Date(),
): Extract<MemoryEvent, { action: "add" }> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("A note needs some text.");
  if (trimmed.length > 500) throw new Error("Keep a note under 500 characters.");
  const event: Extract<MemoryEvent, { action: "add" }> = {
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

function memoryEvent(store: AldenStore, event: MemoryEvent): MemoryEvent {
  store.addEvent({ id: event.id, at: event.at, type: "memory", repo: event.repo, body: event });
  return event;
}

const base = (repo: string, now: Date) => ({
  schemaVersion: MEMORY_SCHEMA_VERSION as typeof MEMORY_SCHEMA_VERSION,
  id: randomUUID(),
  at: now.toISOString(),
  repo: repo.toLowerCase(),
});

const checkNote = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("A note needs some text.");
  if (trimmed.length > 500) throw new Error("Keep a note under 500 characters.");
  return trimmed;
};

/** Rewrites a note. Returns false when `repo` has no note by that id. */
export async function editNote(store: AldenStore, repo: string, item: string, text: string, now = new Date()) {
  const trimmed = checkNote(text);
  const learning = await loadLearning(store, repo, now);
  if (!learning.notes.some((n) => n.id === item)) return false;
  memoryEvent(store, { ...base(repo, now), action: "edit", item, text: trimmed });
  return true;
}

/** Takes back a forget, for a note or a learned item. Returns false when nothing by that id was forgotten. */
export function restore(store: AldenStore, repo: string, item: string, now = new Date()): boolean {
  const forgotten = memoryEvents(store, repo).some((e) => e.action === "forget" && e.item === item);
  if (!forgotten) return false;
  memoryEvent(store, { ...base(repo, now), action: "restore", item });
  return true;
}

/** Pauses or resumes learning in a repo: while paused, what was learned is kept but not applied. */
export function setLearning(store: AldenStore, repo: string, on: boolean, now = new Date()): void {
  memoryEvent(store, on ? { ...base(repo, now), action: "resume" } : { ...base(repo, now), action: "pause" });
}

/** Forgets every note and learned item in a repo. Returns how many. */
export async function forgetAll(store: AldenStore, repo: string, now = new Date()): Promise<number> {
  const items = memoryItems(await loadLearning(store, repo, now));
  for (const item of items) memoryEvent(store, { ...base(repo, now), action: "forget", item: item.id });
  return items.length;
}

/** Records a reaction to a PR row in the queue. */
export function recordReaction(
  store: AldenStore,
  row: Pick<QueueRow, "repo" | "number" | "features">,
  reaction: ReactionEvent["reaction"],
  updatedAt: string,
  now = new Date(),
): ReactionEvent {
  const event: ReactionEvent = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: randomUUID(),
    at: now.toISOString(),
    repo: row.repo.toLowerCase(),
    number: row.number,
    reaction,
    features: row.features,
    updatedAt,
  };
  store.addEvent({ id: event.id, at: event.at, type: "reaction", repo: event.repo, body: event });
  return event;
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
  /** When the PR last changed, so a dismissal lasts until the next change. */
  updatedAt?: string;
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
