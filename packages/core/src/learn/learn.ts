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
import { authorName, prAuthor } from "./authors.js";

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
/** Checks Alden never quietens, however often they're marked not useful. */
const NEVER_QUIETENED = new Set(["secrets.likely", "injection.ai"]);

/**
 * Checks that teach one lesson together. A changed public signature and the callers of it outside the diff are two
 * views of one API change: a reviewer who doesn't need one rarely needs the other, and their reactions are split
 * across two rows. Every other check is its own topic.
 */
const CHECK_TOPICS: Record<string, string> = { "signatures.changed": "api", "callers.outside": "api" };
/** The lesson a check's flags count toward: "api" for signatures and callers, otherwise the check's own id. */
export const checkTopic = (checkId: string) => CHECK_TOPICS[checkId] ?? checkId;
/** What a check's (or topic's) flags are called in a sentence. */
const CHECK_NAMES: Record<string, string> = {
  "tests.missing": "untested-change flags",
  "migrations.changed": "migration flags",
  "config.changed": "config-change flags",
  "paths.sensitive": "sensitive-path flags",
  "dependencies.changed": "dependency flags",
  "secrets.likely": "possible-secret flags",
  api: "API change flags",
  "injection.ai": "flags about text aimed at AI reviewers",
};
export const checkName = (id: string) => CHECK_NAMES[checkTopic(id)] ?? `${id} flags`;

/**
 * Topics the model tags its findings with, as the check topic each one counts toward, so "not useful" on a model
 * finding about missing tests teaches the same lesson as on the untested-change check.
 */
export const MODEL_TOPICS = {
  tests: "tests.missing",
  api: "signatures.changed",
  migrations: "migrations.changed",
  config: "config.changed",
  dependencies: "dependencies.changed",
} as const;

/** A check topic whose flags you consistently find useful, or consistently don't. */
export interface CheckLesson {
  id: string;
  /** The check's id, or "api" for signature and caller flags together. */
  topic: string;
  direction: "up" | "down";
  agree: number;
  notNeeded: number;
  since: string;
}

/** The lesson in force for a check's flags, through its topic. */
export function checkLesson(learning: Learning | undefined, checkId: string): CheckLesson | undefined {
  if (!learning || learning.paused) return undefined;
  return learning.checks.get(checkTopic(checkId));
}

/**
 * A kind of PR that ranks higher (you open it ahead of its rank, or mark it useful) or lower (you mark it not
 * useful). Learned per feature: a sensitive directory or code area, who wrote it, a label, dependency changes.
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
  /** Lessons by check topic: see `checkLesson`. */
  checks: Map<string, CheckLesson>;
  /** Useful and not useful counted so far per check topic, lesson or not, so feedback can say how close it is. */
  checkTallies: Map<string, { agree: number; notNeeded: number }>;
  queue: QueueLesson[];
  /** Evidence counted so far per queue feature, lesson or not: PRs opened, opened ahead, marked useful, not useful. */
  queueTallies: Map<string, { opens: number; jumps: number; ups: number; downs: number }>;
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

/** A PR's code areas count at most this many, the ones with the most changed lines: a sprawling PR says little. */
export const MAX_AREAS = 3;

/**
 * A file's code area: its first two folders ("app/api/users/route.ts" → "app/api"), its folder when it has one
 * ("py/x.py" → "py"), or "." for a file at the root.
 */
export function codeArea(path: string): string {
  const dirs = path.split("/").slice(0, -1);
  return dirs.length === 0 ? "." : dirs.slice(0, 2).join("/");
}

/** Who wrote a PR, as features: their kind ("by:agents") and, for a bot or agent, which ("author:bot:dependabot"). */
function authorFeatures(pr: PullRequestFacts, viewer: string | undefined): string[] {
  const author = prAuthor(pr, viewer);
  if (!author) return [];
  switch (author.kind) {
    case "you":
      return ["by:you"];
    case "person":
      return ["by:people", `author:${author.id}`];
    case "bot":
      return ["by:bots", `author:bot:${author.id}`];
    case "agent":
      return ["by:agents", `author:agent:${author.id}`, ...(author.person ? [`author:${author.person}`] : [])];
  }
}

/**
 * What a PR is about, as learning features: the sensitive directories and code areas it touches, dependency
 * changes, who wrote it (you, a person, a bot or an AI agent, and which), and its labels. Lockfiles are covered by
 * "kind:dependency", not by name or area. `viewer` is your login, so your own PRs are "by:you".
 */
export function prFeatures(pr: PullRequestFacts, sensitivePaths: string[], viewer?: string): string[] {
  const isSensitive = sensitiveMatcher(sensitivePaths);
  const features = new Set<string>();
  const areaLines = new Map<string, number>();
  for (const file of pr.files) {
    if (isSensitive(file.path) && !isLockfile(file.path)) features.add(`path:${sensitiveDir(file.path, isSensitive)}`);
    if (fileKind(file.path) === "dependency") features.add("kind:dependency");
    if (isLockfile(file.path)) continue;
    const area = codeArea(file.path);
    areaLines.set(area, (areaLines.get(area) ?? 0) + file.additions + file.deletions);
  }
  const areas = [...areaLines]
    // A sensitive directory already says it: "path:db/migrations/" covers "area:db/migrations".
    .filter(([area]) => !features.has(`path:${area}/`))
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, MAX_AREAS);
  for (const [area] of areas) features.add(`area:${area}`);
  for (const feature of authorFeatures(pr, viewer)) features.add(feature);
  for (const label of pr.labels) features.add(`label:${label.toLowerCase()}`);
  return [...features].sort();
}

const AUTHOR_KINDS: Record<string, string> = {
  you: "your own PRs",
  people: "PRs from people",
  bots: "bot PRs",
  agents: "PRs from AI agents",
};

/** "path:db/migrations/" → "PRs touching db/migrations/", "author:bot:dependabot" → "Dependabot PRs". */
export function describeFeature(feature: string): string {
  const [kind, ...rest] = feature.split(":");
  const value = rest.join(":");
  if (kind === "path") return `PRs touching ${value}`;
  if (kind === "area") return value === "." ? "PRs touching files at the repo root" : `PRs touching ${value}`;
  if (kind === "by") return AUTHOR_KINDS[value] ?? feature;
  if (kind === "author" && (value.startsWith("bot:") || value.startsWith("agent:"))) {
    const [who, id] = value.split(":") as ["bot" | "agent", string];
    return `${authorName(who, id)} PRs`;
  }
  if (kind === "author") return `@${value}'s PRs`;
  if (kind === "label") return `PRs labelled ${value}`;
  if (feature === "kind:dependency") return "dependency changes";
  return feature;
}

/**
 * Features that say the same kind of thing: who wrote it, what it touches, how it's labelled. Lessons in one family
 * don't add up (a Dependabot PR is a bot PR too), so learning one thing twice can't double its effect.
 */
export function featureFamily(feature: string): string {
  if (feature.startsWith("author:") || feature.startsWith("by:")) return "author";
  if (feature.startsWith("label:")) return "label";
  return "files";
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

  // The latest verdict per flag per briefing, then per flag per PR for dismissals. A model finding counts toward the
  // check topic it's tagged with, once per briefing however many findings share the topic, so one chatty review
  // can't teach a lesson on its own.
  const latest = new Map<string, Extract<FeedbackEvent, { kind: "verdict" }>>();
  const latestOnPr = new Map<string, Extract<FeedbackEvent, { kind: "verdict" }>>();
  for (const event of input.feedback) {
    if (event.kind !== "verdict") continue;
    const key = dismissKey(feedbackTargetKey(event), event.item);
    const { item } = event;
    const flag = item.source === "llm" && item.checkId ? `llm|${checkTopic(item.checkId)}` : `${key}|${item.placement}`;
    latest.set(`${event.briefingAt}|${feedbackTargetKey(event)}|${flag}`, event);
    latestOnPr.set(key, event);
  }
  const dismissed = new Map<string, string>();
  for (const [key, event] of latestOnPr) if (event.verdict === "dismiss") dismissed.set(key, event.at);

  // Each direction counts after its own forget, by topic or (from before topics) by the check's own id.
  const afterCheck = (checkId: string, direction: "up" | "down", at: string) =>
    after(`check:${checkTopic(checkId)}:${direction}`, at) && after(`check:${checkId}:${direction}`, at);
  const tallies = new Map<string, { agree: number; notNeeded: number; since: string }>();
  for (const event of latest.values()) {
    const checkId = event.item.checkId;
    if (!checkId || (event.verdict !== "agree" && event.verdict !== "not_needed")) continue;
    const topic = checkTopic(checkId);
    const tally = tallies.get(topic) ?? { agree: 0, notNeeded: 0, since: event.at };
    if (event.verdict === "agree" && afterCheck(checkId, "up", event.at)) tally.agree++;
    if (event.verdict === "not_needed" && afterCheck(checkId, "down", event.at)) tally.notNeeded++;
    if (event.at < tally.since) tally.since = event.at;
    tallies.set(topic, tally);
  }
  const checks = new Map<string, CheckLesson>();
  for (const [topic, { agree, notNeeded, since }] of tallies) {
    const total = agree + notNeeded;
    if (agree >= MIN_EVIDENCE && agree / total >= CHECK_RATIO) {
      checks.set(topic, { id: `check:${topic}:up`, topic, direction: "up", agree, notNeeded, since });
    } else if (notNeeded >= MIN_EVIDENCE && notNeeded / total >= CHECK_RATIO && !NEVER_QUIETENED.has(topic)) {
      checks.set(topic, { id: `check:${topic}:down`, topic, direction: "down", agree, notNeeded, since });
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
  // Each PR counts once per feature, as opened ahead if any of its opens was: opening one PR on three days is one
  // PR, not three. An open jumped ahead for a feature only when a PR it passed lacked that feature (events from
  // before that was recorded: when it passed any PR), so a feature on every PR in the queue never jumps.
  const opened = new Map<string, { at: string; jumped: boolean }>();
  for (const open of input.opens) {
    if (open.at < windowStart || open.position < 0) continue;
    for (const feature of open.features) {
      if (!after(`queue:${feature}:up`, open.at)) continue;
      const key = `${feature}|${open.repo.toLowerCase()}#${open.number}`;
      const jumped = open.position > 0 && (open.jumped === undefined || open.jumped.includes(feature));
      const seen = opened.get(key);
      if (!seen) opened.set(key, { at: open.at, jumped });
      else if (jumped && !seen.jumped) opened.set(key, { at: open.at, jumped });
    }
  }
  for (const [key, { at, jumped }] of opened) {
    const t = tally(key.slice(0, key.lastIndexOf("|")));
    t.opens++;
    if (jumped) {
      t.jumps++;
      t.upSince = earliest(t.upSince, at);
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
    checkTallies: new Map([...tallies].map(([topic, t]) => [topic, { agree: t.agree, notNeeded: t.notNeeded }])),
    queue,
    queueTallies: new Map(
      [...byFeature].map(([feature, t]) => [feature, { opens: t.opens, jumps: t.jumps, ups: t.ups, downs: t.downs }]),
    ),
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

/**
 * Points a PR gets or loses from how you treat PRs like it, and the reason to show. Each family of features (who
 * wrote it, what it touches, its labels) counts once, so "bot PRs" and "Dependabot PRs" learned from the same
 * reactions don't add up. Nothing while paused.
 */
export function queueBoost(learning: Learning | undefined, features: string[]): { points: number; reason?: string } {
  if (!learning || learning.paused) return { points: 0 };
  const matched = learning.queue.filter((lesson) => features.includes(lesson.feature));
  if (matched.length === 0) return { points: 0 };
  const byFamily = new Map<string, number>();
  for (const l of matched) {
    const family = featureFamily(l.feature);
    byFamily.set(family, (byFamily.get(family) ?? 0) + (l.direction === "up" ? 1 : -1));
  }
  const raw = [...byFamily.values()].reduce((sum, n) => sum + Math.sign(n) * OPEN_BOOST, 0);
  const points = Math.max(-MAX_OPEN_BOOST, Math.min(MAX_OPEN_BOOST, raw));
  if (points === 0) return { points: 0 };
  const lead = matched.find((l) => (points > 0 ? l.direction === "up" : l.direction === "down")) as QueueLesson;
  return { points, reason: queueReason(lead) };
}

/** "ranked higher: you usually open PRs touching db/ first", "ranked lower: you usually skip Dependabot PRs (4 marked not useful)". */
export function queueReason(lesson: QueueLesson): string {
  const what = describeFeature(lesson.feature);
  if (lesson.direction === "down")
    return `ranked lower: you usually skip ${what} (${lesson.reactions} marked not useful)`;
  return lesson.jumps >= lesson.reactions
    ? `ranked higher: you usually open ${what} first`
    : `ranked higher: you marked ${lesson.reactions} ${what} useful`;
}

/** The sentence for a check lesson, as a place to look shows it. */
export function checkReason(lesson: CheckLesson): string {
  const total = lesson.agree + lesson.notNeeded;
  return lesson.direction === "up"
    ? `You usually mark ${checkName(lesson.topic)} useful (${lesson.agree} of ${total})`
    : `You usually mark ${checkName(lesson.topic)} not useful (${lesson.notNeeded} of ${total})`;
}

/** A check row quietened by your feedback says so, the same way everywhere: "quietened by your feedback: …". */
export function quietenedReason(lesson: CheckLesson): string {
  return `quietened by your feedback: ${lowerFirst(checkReason(lesson))}`;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

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
      text: up
        ? `You find ${checkName(lesson.topic)} useful`
        : `You usually find ${checkName(lesson.topic)} not useful`,
      evidence: `${up ? `you marked ${lesson.agree} of ${total} useful` : `you marked ${lesson.notNeeded} of ${total} not useful`}${lesson.topic === "api" ? " (public signature and caller flags count together)" : ""}`,
      examples: total,
      effect: up
        ? "Picked first among the places to look, and the model is told you care."
        : "Left out of the places to look unless high or critical severity, marked quietened in the checks, and the model is told not to raise them unless serious.",
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
      text: up ? `You look at ${what} first` : `You usually skip ${what}`,
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

/**
 * Notes and learned check preferences, as lines for the model's prompt: what you care about, and what you usually
 * find not useful, so the model stops raising concerns your feedback quietened.
 */
export function promptNotes(learning: Learning | undefined): string[] {
  if (!learning) return [];
  const lessons = learning.paused ? [] : [...learning.checks.values()];
  const topic = (l: CheckLesson) => checkName(l.topic).replace(/ flags$/, "");
  return [
    ...learning.notes.map((n) => n.text),
    ...lessons.filter((l) => l.direction === "up").map((l) => `Cares about ${topic(l)} issues.`),
    ...lessons
      .filter((l) => l.direction === "down")
      .map((l) => `Usually finds ${topic(l)} concerns not useful: raise them only when they're serious.`),
  ];
}

// --- Progress ---------------------------------------------------------------------------------------------------

const more = (n: number) => (n === 1 ? "one more" : `${n} more`);

/**
 * What a useful or not useful on a check's flag (or a model finding tagged with a check's topic) did to learning, in
 * one line, read from learning after the verdict was saved: "2 of 3: one more not useful on API change flags and
 * Alden will quieten them". Undefined for a dismiss or a clear.
 */
export function checkProgress(
  learning: Learning,
  item: Pick<FeedbackItem, "source" | "checkId">,
  verdict: Extract<FeedbackEvent, { kind: "verdict" }>["verdict"],
): string | undefined {
  if (verdict !== "agree" && verdict !== "not_needed") return undefined;
  if (!item.checkId) {
    return "Saved. This finding isn't tied to one of Alden's topics, so it counts toward your useful rate but teaches no lesson.";
  }
  const topic = checkTopic(item.checkId);
  const name = checkName(item.checkId);
  const together = topic === "api" ? " (public signature and caller flags count together)" : "";
  if (learning.paused) return "Saved. Learning is paused in this repo, so nothing changes until you resume it.";
  if (verdict === "not_needed" && NEVER_QUIETENED.has(topic)) {
    return `Saved. Alden never quietens ${name}, however often they're marked not useful.`;
  }
  const up = verdict === "agree";
  const { agree, notNeeded } = learning.checkTallies.get(topic) ?? { agree: 0, notNeeded: 0 };
  const count = up ? agree : notNeeded;
  const other = up ? notNeeded : agree;
  const label = up ? "useful" : "not useful";
  const outcome = up ? "put them first among the places to look" : "quieten them";
  const lesson = learning.checks.get(topic);
  if (lesson?.direction === (up ? "up" : "down")) {
    return `${count} of ${count + other} ${label} on ${name}${together}: Alden ${up ? "puts them first among the places to look" : "quietens them"} in this repo.`;
  }
  if (lesson) {
    const kept = lesson.direction === "up" ? lesson.agree : lesson.notNeeded;
    return `Saved. You still mostly mark ${name} ${lesson.direction === "up" ? "useful" : "not useful"} (${kept} of ${lesson.agree + lesson.notNeeded}), so that stays for now.`;
  }
  // Three alike, at least three to one.
  const needed = Math.max(MIN_EVIDENCE - count, 3 * other - count, 1);
  const so =
    count < MIN_EVIDENCE && other === 0 ? `${count} of ${MIN_EVIDENCE}` : `${agree} useful, ${notNeeded} not useful`;
  return `${so}: ${more(needed)} ${label} on ${name}${together} and Alden will ${outcome}.`;
}

/**
 * What a useful or not useful on a PR row did to learning, for the feature closest to a lesson: "Dependabot PRs: 2
 * of 3 not useful. One more and Alden will rank them lower." Undefined for a dismiss or a clear.
 */
export function reactionProgress(
  learning: Learning,
  features: string[],
  reaction: ReactionEvent["reaction"],
): string | undefined {
  if (reaction !== "up" && reaction !== "down") return undefined;
  if (learning.paused) return "Saved. Learning is paused in this repo, so nothing changes until you resume it.";
  const up = reaction === "up";
  const learned = learning.queue.find((l) => features.includes(l.feature) && l.direction === (up ? "up" : "down"));
  if (learned) return `Alden ranks ${describeFeature(learned.feature)} ${up ? "higher" : "lower"} in this repo.`;
  const closest = features
    .map((feature) => {
      const t = learning.queueTallies.get(feature) ?? { opens: 0, jumps: 0, ups: 0, downs: 0 };
      const count = up ? t.jumps + t.ups : t.downs;
      // Up needs three, 60% of opens and reactions; down needs three, three to one.
      const needed = up
        ? Math.max(
            MIN_EVIDENCE - count,
            Math.ceil((OPEN_RATIO * (t.opens + t.ups + t.downs) - count) / (1 - OPEN_RATIO) - 1e-9),
            1,
          )
        : Math.max(MIN_EVIDENCE - count, 3 * (t.jumps + t.ups) - count, 1);
      return { feature, count, needed };
    })
    .sort((a, b) => a.needed - b.needed || b.count - a.count || a.feature.localeCompare(b.feature))[0];
  if (!closest) return undefined;
  const label = up ? "useful (or opened ahead of their rank)" : "not useful";
  const next = closest.needed === 1 ? "One more" : `${closest.needed} more`;
  return `${describeFeature(closest.feature)}: ${closest.count} ${label} so far. ${next} and Alden will rank them ${up ? "higher" : "lower"}.`;
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
 * reads as "in order" and jumping past PRs reads as "this matters more to me", for the features the PRs you passed
 * over lacked. Returns nothing for a reopen.
 */
export function recordOpen(
  store: AldenStore,
  rows: QueueRow[],
  row: QueueRow,
  via: OpenEvent["via"],
  now: Date = new Date(),
): OpenEvent | undefined {
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
  if (opened.has(key(row))) return undefined;
  const passed = row.base < 0 ? [] : rows.filter((r) => r.base >= 0 && r.base < row.base && !opened.has(key(r)));
  const position = row.base < 0 ? -1 : passed.length;
  // Jumping ahead says something about a feature only if a PR you passed over didn't have it.
  const jumped = row.features.filter((f) => passed.some((r) => !r.features.includes(f)));
  const event: OpenEvent = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: randomUUID(),
    at: now.toISOString(),
    repo: row.repo.toLowerCase(),
    number: row.number,
    position,
    features: row.features,
    jumped,
    via,
  };
  store.addEvent({ id: event.id, at: event.at, type: "open", repo: event.repo, body: event });
  return event;
}
