import { randomUUID } from "node:crypto";
import {
  type FeedbackEvent,
  type FeedbackItem,
  MEMORY_SCHEMA_VERSION,
  type MemoryEvent,
  MemoryEventSchema,
  type MemoryItem,
  type MemorySource,
  type OpenEvent,
  OpenEventSchema,
  type PullRequestFacts,
  type ReactionEvent,
  ReactionEventSchema,
  type ReviewSignalEvent,
  type ReviewSignalKind,
} from "@alden/schema";
import { FeedbackLog } from "../feedback/log.js";
import { fileKind, isLockfile, sensitiveMatcher } from "../queue/files.js";
import type { PromptNote } from "../review/llm/prompt.js";
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
/** Whether a check's flags can never be quietened: likely secrets and text aimed at AI reviewers. */
export const neverQuietened = (checkId: string) => NEVER_QUIETENED.has(checkTopic(checkId));

/** Review signals that say a place was worth a word: they count toward "useful", at their weight. */
const UP_SIGNALS = new Set<ReviewSignalKind>(["request_changes", "suggestion", "comment", "applied", "resolved"]);
/** Review signals that are comments on code, so they say where in a repo you look. */
const COMMENT_SIGNALS = new Set<ReviewSignalKind>(["request_changes", "suggestion", "comment", "miss"]);

/** Weights add up in tenths (a silent pass is 0.2): rounded, so fifteen of them make exactly 3. */
const round = (n: number) => Math.round(n * 100) / 100;
/** A weighted count as a sentence shows it: "3", "2.4". */
export const formatWeight = (n: number) => {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

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

/** How much of a lesson's side came from each kind of evidence, in weight. */
export interface LessonWeights {
  /** Your clicks on Useful or Not useful. */
  reactions: number;
  /** Reviews you sent: comments, suggestions and requested changes near a flag (up), or approving past it (down). */
  review: number;
  /** What authors did with your comments: applied a suggestion, resolved a comment. */
  outcome: number;
}

/**
 * A check topic whose flags you consistently find useful, or consistently don't. `agree` and `notNeeded` are weights:
 * a click counts 1, a review signal its own weight.
 */
export interface CheckLesson {
  id: string;
  /** The check's id, or "api" for signature and caller flags together. */
  topic: string;
  direction: "up" | "down";
  agree: number;
  notNeeded: number;
  /** The lesson's side (agree for up, notNeeded for down), by where it came from. */
  weights: LessonWeights;
  sources: MemorySource[];
  since: string;
}

/** Where a check topic stands, lesson or not: weights for each side, and clicks on Not useful among them. */
export interface CheckTally {
  agree: number;
  notNeeded: number;
  /** Clicks on Not useful: a lesson to quieten needs at least one, so approving in silence never quietens alone. */
  saidNotNeeded: number;
  /** Of `agree`, what came from reviews and their outcomes. */
  reviewAgree: number;
  /** Of `notNeeded`, what came from approving past a flag you saw. */
  reviewNotNeeded: number;
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
  /** Up: reviews you sent with comments in this code area, each counted like an open ahead of rank. Down: 0. */
  reviews: number;
  sources: MemorySource[];
  /** Everything counted for this direction's ratio. */
  total: number;
  since: string;
}

export interface QueueTally {
  opens: number;
  jumps: number;
  ups: number;
  downs: number;
  reviews: number;
}

export interface Note {
  id: string;
  text: string;
  since: string;
  /** Folders and files you stopped applying it to, e.g. "app/api": see `isUnder`. */
  excluded: string[];
  /** Reviews in which you marked a finding that came from it useful (once per review). */
  confirmed: number;
}

export interface Learning {
  repo: string;
  /** Learning paused: what was learned is listed but not applied. Notes and dismissals still apply. */
  paused: boolean;
  /** Lessons by check topic: see `checkLesson`. */
  checks: Map<string, CheckLesson>;
  /** Useful and not useful counted so far per check topic, lesson or not, so feedback can say how close it is. */
  checkTallies: Map<string, CheckTally>;
  queue: QueueLesson[];
  /**
   * Evidence counted so far per queue feature, lesson or not: PRs opened, opened ahead, marked useful, not useful, and
   * reviews with comments in it.
   */
  queueTallies: Map<string, QueueTally>;
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

/**
 * A folder or file a note can be stopped under, as stored: no leading "./" or "/", no trailing "/". Throws on an
 * empty path or one that climbs out of the repo.
 */
export function notePath(path: string): string {
  const clean = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!clean || clean === "." || clean.split("/").includes("..")) throw new Error("Give a folder or file in the repo.");
  return clean;
}

/** Whether `path` is the file `prefix`, or under the folder `prefix`. */
export function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Where "stop applying this note" offers to stop it, for a finding on `path`: the file's first two folders
 * ("app/api/users/route.ts" → "app/api"), its folder when it has one, or the file itself at the repo root.
 */
export function noteArea(path: string): string {
  const area = codeArea(path);
  return area === "." ? path : area;
}

/** Whether you stopped applying a note everywhere a finding points: then the finding is left out. */
export function noteStoppedAt(learning: Learning | undefined, noteId: string, paths: string[]): string | undefined {
  const note = learning?.notes.find((n) => n.id === noteId);
  if (!note || paths.length === 0) return undefined;
  const at = paths.map((p) => note.excluded.find((prefix) => isUnder(p, prefix)));
  return at.every(Boolean) ? (at[0] as string) : undefined;
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

/** One piece of evidence toward a lesson, before it's summed. */
interface Evidence {
  from: MemorySource["from"];
  pr?: string;
  weight: number;
  at: string;
}

/** A check topic's evidence, each side apart. */
interface TopicEvidence {
  up: Evidence[];
  down: Evidence[];
  saidNotNeeded: number;
  since: string;
}

const sumWeights = (evidence: Evidence[]) => round(evidence.reduce((sum, e) => sum + e.weight, 0));

/** At most this many sources are listed per learned item, the latest. */
const MAX_SOURCES = 10;

/**
 * A lesson's evidence as sources to list (your clicks together, each review or outcome by PR; the latest first) and
 * as weights by kind.
 */
function describeEvidence(evidence: Evidence[]): { weights: LessonWeights; sources: MemorySource[] } {
  const weights: LessonWeights = { reactions: 0, review: 0, outcome: 0 };
  const byPlace = new Map<string, MemorySource>();
  for (const e of evidence) {
    weights[e.from === "opens" ? "reactions" : e.from] += e.weight;
    const key = `${e.from}|${e.pr ?? ""}`;
    const held = byPlace.get(key);
    if (held) {
      held.weight = round(held.weight + e.weight);
      if (e.at > held.at) held.at = e.at;
    } else byPlace.set(key, { from: e.from, ...(e.pr ? { pr: e.pr } : {}), weight: e.weight, at: e.at });
  }
  return {
    weights: { reactions: round(weights.reactions), review: round(weights.review), outcome: round(weights.outcome) },
    sources: [...byPlace.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_SOURCES),
  };
}

export function learn(input: {
  repo: string;
  feedback: FeedbackEvent[];
  opens: OpenEvent[];
  memory: MemoryEvent[];
  reactions?: ReactionEvent[];
  /** What your sent reviews (and their outcomes) said: see `ReviewSignalEventSchema`. */
  signals?: ReviewSignalEvent[];
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
        notes.set(event.item, { id: event.item, text: event.text, since: event.at, excluded: [], confirmed: 0 });
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
      case "exclude":
      case "include": {
        const note = notes.get(event.item);
        if (!note) break;
        const path = notePath(event.path);
        const rest = note.excluded.filter((p) => p !== path);
        notes.set(event.item, { ...note, excluded: event.action === "exclude" ? [...rest, path] : rest });
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
  // A finding from one of your notes teaches the note, not a check: useful confirms it, once per review.
  const latestOnNote = new Map<string, Extract<FeedbackEvent, { kind: "verdict" }>>();
  for (const event of input.feedback) {
    if (event.kind !== "verdict") continue;
    const key = dismissKey(feedbackTargetKey(event), event.item);
    const { item } = event;
    if (item.note) {
      latestOnNote.set(`${event.briefingAt}|${feedbackTargetKey(event)}|${item.note}`, event);
      latestOnPr.set(key, event);
      continue;
    }
    const flag = item.source === "llm" && item.checkId ? `llm|${checkTopic(item.checkId)}` : `${key}|${item.placement}`;
    latest.set(`${event.briefingAt}|${feedbackTargetKey(event)}|${flag}`, event);
    latestOnPr.set(key, event);
  }
  const dismissed = new Map<string, string>();
  for (const [key, event] of latestOnPr) if (event.verdict === "dismiss") dismissed.set(key, event.at);
  for (const event of latestOnNote.values()) {
    const note = event.item.note ? notes.get(event.item.note) : undefined;
    if (note && event.verdict === "agree") note.confirmed++;
  }

  // Each direction counts after its own forget, by topic or (from before topics) by the check's own id.
  const afterCheck = (checkId: string, direction: "up" | "down", at: string) =>
    after(`check:${checkTopic(checkId)}:${direction}`, at) && after(`check:${checkId}:${direction}`, at);
  const tallies = new Map<string, TopicEvidence>();
  const topicOf = (topic: string, at: string) => {
    const tally = tallies.get(topic) ?? { up: [], down: [], saidNotNeeded: 0, since: at };
    if (at < tally.since) tally.since = at;
    tallies.set(topic, tally);
    return tally;
  };
  for (const event of latest.values()) {
    const checkId = event.item.checkId;
    if (!checkId || (event.verdict !== "agree" && event.verdict !== "not_needed")) continue;
    const tally = topicOf(checkTopic(checkId), event.at);
    // A verdict marked `via: "comment"` was a comment in a review you sent, from before review signals.
    const evidence: Evidence =
      event.via === "comment"
        ? { from: "review", pr: feedbackTargetKey(event), weight: 1, at: event.at }
        : { from: "reactions", weight: 1, at: event.at };
    if (event.verdict === "agree" && afterCheck(checkId, "up", event.at)) tally.up.push(evidence);
    if (event.verdict === "not_needed" && afterCheck(checkId, "down", event.at)) {
      tally.down.push(evidence);
      tally.saidNotNeeded++;
    }
  }
  // Review signals count once per PR per topic, at the strongest: two suggestions on one PR's untested code count 2,
  // not 4, so no single review teaches a lesson on its own. A comment on a topic in a PR outweighs approving past
  // another of its flags there. What the author did afterwards counts on its own, once per PR per topic too.
  const strongest = new Map<string, { topic: string; evidence: Evidence; direction: "up" | "down" }>();
  for (const signal of input.signals ?? []) {
    if (!signal.checkId) continue;
    const direction = UP_SIGNALS.has(signal.signal) ? "up" : signal.signal === "silent_pass" ? "down" : undefined;
    if (!direction || !afterCheck(signal.checkId, direction, signal.at)) continue;
    const topic = checkTopic(signal.checkId);
    const pr = `${signal.repo.toLowerCase()}#${signal.pr}`;
    const key = `${signal.source}|${pr}|${topic}`;
    const held = strongest.get(key);
    const evidence: Evidence = { from: signal.source, pr, weight: signal.weight, at: signal.at };
    if (
      !held ||
      (direction === "up" && held.direction === "down") ||
      (direction === held.direction && signal.weight > held.evidence.weight)
    ) {
      strongest.set(key, { topic, evidence, direction });
    }
  }
  for (const { topic, evidence, direction } of strongest.values()) {
    topicOf(topic, evidence.at)[direction].push(evidence);
  }

  const checks = new Map<string, CheckLesson>();
  const checkTallies = new Map<string, CheckTally>();
  for (const [topic, { up, down, saidNotNeeded, since }] of tallies) {
    const agree = sumWeights(up);
    const notNeeded = sumWeights(down);
    const total = agree + notNeeded;
    checkTallies.set(topic, {
      agree,
      notNeeded,
      saidNotNeeded,
      reviewAgree: sumWeights(up.filter((e) => e.from !== "reactions")),
      reviewNotNeeded: sumWeights(down.filter((e) => e.from !== "reactions")),
    });
    const lesson = { topic, agree, notNeeded, since };
    if (agree >= MIN_EVIDENCE && agree / total >= CHECK_RATIO) {
      checks.set(topic, { ...lesson, id: `check:${topic}:up`, direction: "up", ...describeEvidence(up) });
    } else if (
      notNeeded >= MIN_EVIDENCE &&
      notNeeded / total >= CHECK_RATIO &&
      saidNotNeeded > 0 &&
      !NEVER_QUIETENED.has(topic)
    ) {
      checks.set(topic, { ...lesson, id: `check:${topic}:down`, direction: "down", ...describeEvidence(down) });
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
  type Tally = QueueTally & {
    upSince?: string;
    downSince?: string;
    /** When each kind of evidence was last seen, and reviews by PR, for the sources a lesson lists. */
    jumpsAt?: string;
    upsAt?: string;
    downsAt?: string;
    reviewed: Map<string, { n: number; at: string }>;
  };
  const byFeature = new Map<string, Tally>();
  const tally = (feature: string) => {
    const t: Tally = byFeature.get(feature) ?? {
      opens: 0,
      jumps: 0,
      ups: 0,
      downs: 0,
      reviews: 0,
      reviewed: new Map(),
    };
    byFeature.set(feature, t);
    return t;
  };
  const earliest = (a: string | undefined, b: string) => (a && a < b ? a : b);
  const latestOf = (a: string | undefined, b: string) => (a && a > b ? a : b);
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
      t.jumpsAt = latestOf(t.jumpsAt, at);
    }
  }
  // A review you sent with comments in a code area counts as opening a PR there ahead of its rank: once per review
  // per area, however many comments it has there. Signals from one review share its time.
  const reviewed = new Map<string, { feature: string; pr: string; at: string }>();
  for (const signal of input.signals ?? []) {
    if (signal.source !== "review" || !COMMENT_SIGNALS.has(signal.signal) || !signal.path) continue;
    if (signal.at < windowStart || isLockfile(signal.path)) continue;
    const feature = `area:${codeArea(signal.path)}`;
    if (!after(`queue:${feature}:up`, signal.at)) continue;
    const pr = `${signal.repo.toLowerCase()}#${signal.pr}`;
    reviewed.set(`${feature}|${pr}@${signal.at}`, { feature, pr, at: signal.at });
  }
  for (const { feature, pr, at } of reviewed.values()) {
    const t = tally(feature);
    t.reviews++;
    t.upSince = earliest(t.upSince, at);
    const held = t.reviewed.get(pr);
    t.reviewed.set(pr, { n: (held?.n ?? 0) + 1, at: latestOf(held?.at, at) });
  }
  for (const r of reactionByPr.values()) {
    if (r.at < windowStart || (r.reaction !== "up" && r.reaction !== "down")) continue;
    for (const feature of r.features) {
      const t = tally(feature);
      if (r.reaction === "up" && after(`queue:${feature}:up`, r.at)) {
        t.ups++;
        t.upSince = earliest(t.upSince, r.at);
        t.upsAt = latestOf(t.upsAt, r.at);
      }
      if (r.reaction === "down" && after(`queue:${feature}:down`, r.at)) {
        t.downs++;
        t.downSince = earliest(t.downSince, r.at);
        t.downsAt = latestOf(t.downsAt, r.at);
      }
    }
  }
  const queue: QueueLesson[] = [];
  for (const [feature, t] of byFeature) {
    const up = t.jumps + t.ups + t.reviews;
    const upTotal = t.opens + t.reviews + t.ups + t.downs;
    if (up >= MIN_EVIDENCE && up / upTotal >= OPEN_RATIO && t.upSince) {
      const sources: MemorySource[] = [
        ...[...t.reviewed].map(([pr, { n, at }]): MemorySource => ({ from: "review", pr, weight: n, at })),
        ...(t.jumps > 0 && t.jumpsAt ? [{ from: "opens" as const, weight: t.jumps, at: t.jumpsAt }] : []),
        ...(t.ups > 0 && t.upsAt ? [{ from: "reactions" as const, weight: t.ups, at: t.upsAt }] : []),
      ];
      queue.push({
        id: `queue:${feature}:up`,
        feature,
        direction: "up",
        jumps: t.jumps,
        reactions: t.ups,
        reviews: t.reviews,
        sources: sources.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_SOURCES),
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
        reviews: 0,
        sources: t.downsAt ? [{ from: "reactions", weight: t.downs, at: t.downsAt }] : [],
        total: t.downs + up,
        since: t.downSince,
      });
    }
  }
  queue.sort(
    (a, b) =>
      b.jumps + b.reactions + b.reviews - (a.jumps + a.reactions + a.reviews) || a.feature.localeCompare(b.feature),
  );

  return {
    repo: input.repo.toLowerCase(),
    paused,
    checks,
    checkTallies,
    queue,
    queueTallies: new Map(
      [...byFeature].map(([feature, t]) => [
        feature,
        { opens: t.opens, jumps: t.jumps, ups: t.ups, downs: t.downs, reviews: t.reviews },
      ]),
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
  const log = new FeedbackLog(store);
  return learn({
    repo,
    feedback: await log.events(repo),
    signals: log.signals(repo),
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
  // The reason names the lesson with the most evidence; on a tie, who wrote it ("Dependabot PRs") says more than where
  // its files are ("PRs touching web").
  const evidence = (l: QueueLesson) => l.jumps + l.reactions + l.reviews;
  const lead = matched
    .filter((l) => (points > 0 ? l.direction === "up" : l.direction === "down"))
    .sort(
      (a, b) =>
        evidence(b) - evidence(a) ||
        Number(featureFamily(b.feature) === "author") - Number(featureFamily(a.feature) === "author"),
    )[0] as QueueLesson;
  return { points, reason: queueReason(lead) };
}

/** "ranked higher: you usually open PRs touching db/ first", "ranked lower: you usually skip Dependabot PRs (4 marked not useful)". */
export function queueReason(lesson: QueueLesson): string {
  const what = describeFeature(lesson.feature);
  if (lesson.direction === "down")
    return `ranked lower: you usually skip ${what} (${lesson.reactions} marked not useful)`;
  if (lesson.reviews > lesson.jumps && lesson.reviews >= lesson.reactions) {
    return `ranked higher: you often comment on ${what} in your reviews`;
  }
  return lesson.jumps >= lesson.reactions
    ? `ranked higher: you usually open ${what} first`
    : `ranked higher: you marked ${lesson.reactions} ${what} useful`;
}

/** The sentence for a check lesson, as a place to look shows it. */
export function checkReason(lesson: CheckLesson): string {
  const total = formatWeight(lesson.agree + lesson.notNeeded);
  const up = lesson.direction === "up";
  const fromReviews = lesson.weights.review + lesson.weights.outcome;
  // "Mark" while it's all clicks, as before; "find" once your reviews said some of it.
  const verb = fromReviews > 0 ? "find" : "mark";
  const tail = fromReviews > 0 ? `, ${formatWeight(fromReviews)} from your reviews` : "";
  return up
    ? `You usually ${verb} ${checkName(lesson.topic)} useful (${formatWeight(lesson.agree)} of ${total}${tail})`
    : `You usually ${verb} ${checkName(lesson.topic)} not useful (${formatWeight(lesson.notNeeded)} of ${total}${tail})`;
}

/** A check row quietened by your feedback says so, the same way everywhere: "quietened by your feedback: …". */
export function quietenedReason(lesson: CheckLesson): string {
  return `quietened by your feedback: ${lowerFirst(checkReason(lesson))}`;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * What a check lesson was learned from, in words: "you marked 3 of 4 useful" while it's all clicks, otherwise "5 of 5
 * useful: you marked 1, 4 from comments in your reviews (acme/shop#412, acme/shop#413)".
 */
export function checkEvidence(lesson: CheckLesson): string {
  const up = lesson.direction === "up";
  const total = formatWeight(lesson.agree + lesson.notNeeded);
  const side = formatWeight(up ? lesson.agree : lesson.notNeeded);
  const label = up ? "useful" : "not useful";
  const { reactions, review, outcome } = lesson.weights;
  if (review + outcome === 0) return `you marked ${side} of ${total} ${label}`;
  const prs = (from: MemorySource["from"]) => {
    const list = lesson.sources.filter((s) => s.from === from && s.pr).map((s) => s.pr as string);
    return list.length === 0 ? "" : ` (${list.slice(0, 3).join(", ")}${list.length > 3 ? ", …" : ""})`;
  };
  const parts = [
    reactions > 0 && `you marked ${formatWeight(reactions)}`,
    review > 0 &&
      `${formatWeight(review)} from ${up ? "comments in your reviews" : "approving past them in your reviews"}${prs("review")}`,
    outcome > 0 && `${formatWeight(outcome)} from what authors did with your comments${prs("outcome")}`,
  ].filter(Boolean);
  return `${side} of ${total} ${label}: ${parts.join(", ")}`;
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
    effect:
      n.excluded.length > 0
        ? `Given to the model with every review of this repo, except under ${n.excluded.join(", ")}.`
        : "Given to the model with every review of this repo.",
    ...(n.confirmed > 0 ? { confirmed: n.confirmed } : {}),
    ...(n.excluded.length > 0 ? { excluded: n.excluded } : {}),
    since: n.since,
  }));
  const checks: MemoryItem[] = [...learning.checks.values()].map((lesson) => {
    const total = lesson.agree + lesson.notNeeded;
    const up = lesson.direction === "up";
    return {
      sources: lesson.sources,
      id: lesson.id,
      repo,
      source: "learned",
      kind: "check",
      group: up ? "look" : "skip",
      text: up
        ? `You find ${checkName(lesson.topic)} useful`
        : `You usually find ${checkName(lesson.topic)} not useful`,
      evidence: `${checkEvidence(lesson)}${lesson.topic === "api" ? " (public signature and caller flags count together)" : ""}`,
      examples: Math.round(total),
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
          lesson.reviews > 0 && `commented on in ${lesson.reviews} review${lesson.reviews === 1 ? "" : "s"} you sent`,
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
      examples: lesson.jumps + lesson.reactions + lesson.reviews,
      effect: up ? "Ranked higher in your queue." : "Ranked lower in your queue.",
      sources: lesson.sources,
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
 * Notes and learned check preferences, for the model's prompt: your notes (each by its id, so the model can say a
 * finding came from one), what you care about, and what you usually find not useful, so the model stops raising
 * concerns your feedback quietened. Given the change's files, a note you stopped applying under all of them is left
 * out, and one you stopped applying under some of them says where it doesn't apply.
 */
export function promptNotes(learning: Learning | undefined, paths?: string[]): (string | PromptNote)[] {
  if (!learning) return [];
  const lessons = learning.paused ? [] : [...learning.checks.values()];
  const topic = (l: CheckLesson) => checkName(l.topic).replace(/ flags$/, "");
  return [
    ...learning.notes.flatMap((n): PromptNote[] => {
      if (n.excluded.length === 0 || !paths) return [{ id: n.id, text: n.text }];
      const except = n.excluded.filter((prefix) => paths.some((p) => isUnder(p, prefix)));
      if (paths.length > 0 && paths.every((p) => except.some((prefix) => isUnder(p, prefix)))) return [];
      return [{ id: n.id, text: n.text, ...(except.length > 0 ? { except } : {}) }];
    }),
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
  item: Pick<FeedbackItem, "source" | "checkId" | "note">,
  verdict: Extract<FeedbackEvent, { kind: "verdict" }>["verdict"],
): string | undefined {
  if (verdict !== "agree" && verdict !== "not_needed") return undefined;
  if (item.note) {
    const note = learning.notes.find((n) => n.id === item.note);
    if (!note) return "Saved. The note this came from is no longer in memory, so this teaches nothing.";
    return verdict === "agree"
      ? `Saved. Your note is confirmed ${note.confirmed}×.`
      : "Saved. This came from your note, so it teaches no check. Nothing changes unless you stop the note here or edit it.";
  }
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
  const tally = learning.checkTallies.get(topic) ?? EMPTY_TALLY;
  const { agree, notNeeded } = tally;
  const count = up ? agree : notNeeded;
  const other = up ? notNeeded : agree;
  const label = up ? "useful" : "not useful";
  const outcome = up ? "put them first among the places to look" : "quieten them";
  const fromReviews = up ? tally.reviewAgree : tally.reviewNotNeeded;
  const from = fromReviews > 0 ? ` (${formatWeight(fromReviews)} from your reviews)` : "";
  const lesson = learning.checks.get(topic);
  if (lesson?.direction === (up ? "up" : "down")) {
    return `${formatWeight(count)} of ${formatWeight(count + other)} ${label}${from} on ${name}${together}: Alden ${up ? "puts them first among the places to look" : "quietens them"} in this repo.`;
  }
  if (lesson) {
    const kept = lesson.direction === "up" ? lesson.agree : lesson.notNeeded;
    return `Saved. You still mostly mark ${name} ${lesson.direction === "up" ? "useful" : "not useful"} (${formatWeight(kept)} of ${formatWeight(lesson.agree + lesson.notNeeded)}), so that stays for now.`;
  }
  const needed = stillNeeded(count, other);
  const so =
    count < MIN_EVIDENCE && other === 0
      ? `${formatWeight(count)} of ${MIN_EVIDENCE}`
      : `${formatWeight(agree)} useful, ${formatWeight(notNeeded)} not useful`;
  return `${so}${from}: ${more(needed)} ${label} on ${name}${together} and Alden will ${outcome}.`;
}

const EMPTY_TALLY: CheckTally = { agree: 0, notNeeded: 0, saidNotNeeded: 0, reviewAgree: 0, reviewNotNeeded: 0 };

/** Clicks still needed for a lesson, from `count` on its side and `other` against it: three alike, three to one. */
const stillNeeded = (count: number, other: number) =>
  Math.max(Math.ceil(round(MIN_EVIDENCE - count)), Math.ceil(round(3 * other - count)), 1);

/**
 * What a review you sent did to learning, one line per check topic it said something useful about, read from learning
 * after its signals were saved: "2 of 3 (2 from your review of acme/shop#412): one more useful on untested-change
 * flags and Alden will put them first among the places to look." A PR counts once per topic, at its strongest signal
 * (a suggestion or requested change counts 2, a comment 1). Approving past a flag says too little to report.
 */
export function reviewProgress(
  learning: Learning,
  signals: Pick<ReviewSignalEvent, "signal" | "checkId" | "weight">[],
  pr: string,
): string[] {
  if (learning.paused) return [];
  const byTopic = new Map<string, { checkId: string; weight: number }>();
  for (const signal of signals) {
    if (!signal.checkId || !UP_SIGNALS.has(signal.signal)) continue;
    const topic = checkTopic(signal.checkId);
    const held = byTopic.get(topic);
    if (!held || signal.weight > held.weight) byTopic.set(topic, { checkId: signal.checkId, weight: signal.weight });
  }
  return [...byTopic]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([topic, { checkId, weight }]) => {
      const name = checkName(checkId);
      const together = topic === "api" ? " (public signature and caller flags count together)" : "";
      const { agree, notNeeded } = learning.checkTallies.get(topic) ?? EMPTY_TALLY;
      const from = `${formatWeight(weight)} from your review of ${pr}`;
      const lesson = learning.checks.get(topic);
      if (lesson?.direction === "up") {
        return `${formatWeight(agree)} of ${formatWeight(agree + notNeeded)} useful on ${name}${together}, ${from}: Alden puts them first among the places to look in this repo.`;
      }
      if (lesson) {
        return `Your review of ${pr} counted ${formatWeight(weight)} useful on ${name}${together}, but you still mostly find them not useful (${formatWeight(notNeeded)} of ${formatWeight(agree + notNeeded)}), so they stay quietened.`;
      }
      const so =
        agree < MIN_EVIDENCE && notNeeded === 0
          ? `${formatWeight(agree)} of ${MIN_EVIDENCE}`
          : `${formatWeight(agree)} useful, ${formatWeight(notNeeded)} not useful`;
      return `${so} (${from}): ${more(stillNeeded(agree, notNeeded))} useful on ${name}${together} and Alden will put them first among the places to look.`;
    });
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
      const t = learning.queueTallies.get(feature) ?? { opens: 0, jumps: 0, ups: 0, downs: 0, reviews: 0 };
      const count = up ? t.jumps + t.ups + t.reviews : t.downs;
      // Up needs three, 60% of opens, reviews and reactions; down needs three, three to one.
      const needed = up
        ? Math.max(
            MIN_EVIDENCE - count,
            Math.ceil((OPEN_RATIO * (t.opens + t.reviews + t.ups + t.downs) - count) / (1 - OPEN_RATIO) - 1e-9),
            1,
          )
        : Math.max(MIN_EVIDENCE - count, 3 * (t.jumps + t.ups + t.reviews) - count, 1);
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

/**
 * Stops applying a note under a folder or file (`exclude`), or applies it there again (`include`). Returns false when
 * `repo` has no note by that id, or (for include) the note wasn't stopped there.
 */
export async function scopeNote(
  store: AldenStore,
  repo: string,
  item: string,
  path: string,
  action: "exclude" | "include",
  now = new Date(),
): Promise<boolean> {
  const clean = notePath(path);
  const note = (await loadLearning(store, repo, now)).notes.find((n) => n.id === item);
  if (!note) return false;
  if (action === "include" && !note.excluded.includes(clean)) return false;
  if (action === "exclude" && note.excluded.includes(clean)) return true;
  memoryEvent(store, { ...base(repo, now), action, item, path: clean });
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
