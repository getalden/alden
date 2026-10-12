import { createHash } from "node:crypto";
import type {
  Briefing,
  LlmFinding,
  ReviewDraft,
  ReviewSignalEvent,
  ReviewSignalInput,
  ReviewThread,
  Severity,
} from "@alden/schema";
import type { DiffFile } from "../diff/parse.js";
import { recordReviewSignals } from "../feedback/log.js";
import { neverQuietened } from "../learn/learn.js";
import { noteKept } from "../stats/review-time.js";
import { type StoreSource, storeFrom } from "../store/source.js";
import { placeOnDiff, prName, ReviewDrafts, type StoredDraft } from "./drafts.js";
import { isNear, NEAR_LINES } from "./near.js";
import { SIGNAL_WEIGHTS } from "./signals.js";

/**
 * Comments Alden drafts for you from its model's findings, when a model is set up and `drafts.auto` is on (the
 * default). The model writes them in the briefing's own call (see `DRAFTS_PROMPT`); this turns the ones worth a
 * comment into drafts with `source: "alden"`, labelled "Drafted by Alden". They are only ever suggestions: an
 * untouched one is never sent (see `sendReview`), and none of them approves anything. Keeping or editing one makes it
 * yours (`source: "you"`, `drafted` kept), and keep, edit and drop teach Alden about the finding's check.
 */

/** The most comments Alden drafts on one PR: a few worth sending beat a pile to wade through. */
export const MAX_ALDEN_DRAFTS = 5;

/** `drafted.checkId` for a finding the model tagged with no check topic. */
export const MODEL_CHECK = "model";

const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** What making a PR's drafts did. */
export interface AldenDraftsMade {
  /** Drafts Alden made from this briefing. */
  made: StoredDraft[];
  /** Untouched drafts from the PR's previous briefing that these replaced. */
  replaced: number;
}

/** Whether the injection check flagged the briefing's PR: Alden then drafts nothing for it. */
export const injectionFlagged = (briefing: Briefing) =>
  briefing.checks.some((c) => c.id === "injection.ai" && c.status === "flagged");

/** The comment a finding carries, where it would go, or nothing when it doesn't qualify. */
function candidate(finding: LlmFinding, briefing: Briefing) {
  if (!finding.draft || (finding.severity !== "medium" && finding.severity !== "high")) return undefined;
  const anchor = finding.anchors.find((a) => a.line !== undefined);
  if (!anchor || anchor.line === undefined) return undefined;
  // Your feedback hid it: Alden doesn't put words in your mouth about something you said isn't worth it.
  if (briefing.learning?.hidden.some((h) => h.title === finding.title)) return undefined;
  return { finding, draft: finding.draft, path: anchor.path, line: anchor.line };
}

/** Where a review thread is, for `makeAldenDrafts`: its line now, or the line it started on when it's outdated. */
export type ThreadPlace = Pick<ReviewThread, "path" | "line" | "originalLine">;

/** Whether a review thread on the PR is near a line: a conversation is already going on there. */
const threadNear = (threads: ThreadPlace[], path: string, line: number) =>
  threads.some((t) => {
    const at = t.line ?? t.originalLine;
    return t.path === path && at !== null && Math.abs(at - line) <= NEAR_LINES;
  });

/**
 * Makes the drafts for a PR from its model briefing: for each medium or high finding the model drafted a comment for,
 * highest severity first, a draft on its first anchored line, when that line is one GitHub takes a comment on (see
 * `placeOnDiff`), no draft of anyone's is near it already (see `isNear`), and no review thread on the PR (`threads`,
 * outdated ones by the line they started on) is near it: a comment there was already said, perhaps by you, and a
 * second one beside a thread you're replying in is easy to send by mistake. At most `MAX_ALDEN_DRAFTS`. Alden's
 * untouched drafts from the PR's previous briefing are replaced; drafts you kept or edited are yours and never
 * touched. Does nothing unless `enabled` (`drafts.auto`, from your user config), the briefing is a PR's at a known
 * head, and the model's answer came back; and for a PR the injection check flagged it makes none (the briefing says
 * why). `files` is the diff the briefing was built from.
 */
export function makeAldenDrafts(
  briefing: Briefing,
  files: DiffFile[] | undefined,
  options: { enabled: boolean; store?: StoreSource; now?: Date; threads?: ThreadPlace[] },
): AldenDraftsMade {
  const none = { made: [], replaced: 0 };
  const { target } = briefing;
  if (!options.enabled || !files || target.kind !== "pr" || !target.headSha || briefing.llm?.status !== "ok") {
    return none;
  }
  const store = storeFrom(options.store);
  const drafts = new ReviewDrafts(store);
  const pr = prName(target.repo, target.number);
  const headSha = target.headSha;
  const now = options.now ?? new Date();
  const candidates = injectionFlagged(briefing)
    ? []
    : briefing.llm.findings
        .flatMap((f) => candidate(f, briefing) ?? [])
        .map((c, index) => ({ ...c, index }))
        .sort((a, b) => RANK[b.finding.severity] - RANK[a.finding.severity] || a.index - b.index);
  return store.transaction(() => {
    let replaced = 0;
    for (const old of drafts.list(pr)) {
      if (old.source === "alden" && drafts.delete(old.id)) replaced++;
    }
    const made: StoredDraft[] = [];
    for (const c of candidates) {
      if (made.length >= MAX_ALDEN_DRAFTS) break;
      const place = placeOnDiff(files, c.path, c.line, "RIGHT");
      if ("problem" in place) continue;
      const at = { title: c.finding.title, reason: "", anchor: { path: c.path, line: c.line } };
      if (drafts.list(pr).some((d) => isNear(d, at)) || threadNear(options.threads ?? [], c.path, c.line)) continue;
      let draft: StoredDraft;
      try {
        draft = drafts.add(
          {
            pr,
            headSha,
            body: c.draft.body,
            source: "alden",
            place,
            ...(c.draft.suggestion !== undefined ? { suggestion: c.draft.suggestion } : {}),
          },
          now,
        );
      } catch {
        continue; // a suggestion or text the drafts won't take: the finding stays in the briefing, undrafted
      }
      // The severity stays in the row only, so dropping a draft knows whether it may teach "not useful".
      const drafted = { checkId: c.finding.checkId ?? MODEL_CHECK, title: c.finding.title };
      store.run(
        "UPDATE drafts SET drafted = ? WHERE id = ?",
        JSON.stringify({ ...drafted, severity: c.finding.severity }),
        draft.id,
      );
      made.push({ ...draft, drafted });
    }
    return { made, replaced };
  });
}

// --- Keep, edit, drop -------------------------------------------------------------------------------------------

/** "owner/repo#12" as its repo and number. */
function prParts(pr: string): { repo: string; number: number } | undefined {
  const match = /^(.+)#(\d+)$/.exec(pr);
  return match ? { repo: match[1] as string, number: Number(match[2]) } : undefined;
}

/**
 * The review signal one of Alden's drafts gives when you keep (or edit) or drop it, at its line and for its finding's
 * check. Its id is the draft's place and finding, so doing it twice on a PR counts once. Undefined when it teaches no
 * check: a finding the model tagged with none, or a general note.
 */
function signalFor(draft: ReviewDraft, signal: "comment" | "silent_pass"): Omit<ReviewSignalInput, "at"> | undefined {
  const parts = prParts(draft.pr);
  const checkId = draft.drafted?.checkId;
  if (!parts || !checkId || checkId === MODEL_CHECK || draft.path === undefined) return undefined;
  const key = [draft.pr.toLowerCase(), checkId, draft.drafted?.title, draft.path, draft.line ?? ""].join("|");
  return {
    id: `alden-${signal === "comment" ? "keep" : "drop"}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
    repo: parts.repo,
    pr: parts.number,
    source: "review",
    signal,
    weight: SIGNAL_WEIGHTS[signal],
    checkId,
    path: draft.path,
    ...(draft.line !== undefined ? { line: draft.line } : {}),
  };
}

/**
 * Keeps Alden's drafts: by id, or every one on a PR (`pr`, "owner/repo#12"). Each becomes yours (`source: "you"`,
 * keeping `drafted`), so it's sent with the review like anything you wrote; drafts that are already yours are left as
 * they are. Editing one of Alden's drafts keeps it the same way (the UI's server calls this after the edit). Each
 * kept draft counts, once, as a comment near its finding's place (a `comment` review signal), unless `learn` is off
 * (`learning.fromReviews`): sending it later adds nothing more for that place, so it isn't counted twice. Returns the
 * drafts kept and the signals recorded.
 */
export async function keepAldenDrafts(
  which: { ids?: string[]; pr?: string },
  options: { store?: StoreSource; learn?: boolean; now?: Date } = {},
): Promise<{ kept: StoredDraft[]; signals: ReviewSignalEvent[] }> {
  const store = storeFrom(options.store);
  const drafts = new ReviewDrafts(store);
  const now = options.now ?? new Date();
  const chosen = [
    ...(which.ids ?? []).flatMap((id) => drafts.get(id) ?? []),
    ...(which.pr ? drafts.list(which.pr) : []),
  ].filter((d, i, all) => d.source === "alden" && all.findIndex((x) => x.id === d.id) === i);
  const kept = store.transaction(() =>
    chosen.map((d) => {
      store.run("UPDATE drafts SET source = 'you', updated_at = ? WHERE id = ?", now.toISOString(), d.id);
      return drafts.get(d.id) as StoredDraft;
    }),
  );
  // For time to review: how many of Alden's drafts you kept, per PR.
  try {
    const byPr = new Map<string, number>();
    for (const d of kept) byPr.set(d.pr, (byPr.get(d.pr) ?? 0) + 1);
    for (const [pr, count] of byPr) noteKept(store, pr, count, now);
  } catch {
    // only the count is lost
  }
  const signals = await learnSafely(
    kept.flatMap((d) => signalFor(d, "comment") ?? []),
    store,
    options,
    now,
  );
  return { kept, signals };
}

/**
 * Drops Alden's drafts by id (deleting them), as the drawer's Drop or Delete does. Each teaches a weak "not useful"
 * for its finding's check, once per place per PR, as approving past a place you saw does (a `silent_pass`, 0.2 of a
 * click: never enough alone to quieten a check): except for checks Alden never quietens (secrets, text aimed at AI
 * reviewers) and critical findings, and not at all while `learn` is off. A draft that isn't Alden's is left alone
 * here. Returns the drafts dropped and the signals recorded.
 */
export async function dropAldenDrafts(
  ids: string[],
  options: { store?: StoreSource; learn?: boolean; now?: Date } = {},
): Promise<{ dropped: StoredDraft[]; signals: ReviewSignalEvent[] }> {
  const store = storeFrom(options.store);
  const drafts = new ReviewDrafts(store);
  const now = options.now ?? new Date();
  const dropped: { draft: StoredDraft; severity?: string }[] = [];
  store.transaction(() => {
    for (const id of ids) {
      const draft = drafts.get(id);
      if (draft?.source !== "alden") continue;
      const row = store.get<{ drafted: string | null }>("SELECT drafted FROM drafts WHERE id = ?", id);
      let severity: string | undefined;
      try {
        severity = (JSON.parse(row?.drafted ?? "{}") as { severity?: string }).severity;
      } catch {
        severity = undefined;
      }
      drafts.delete(id);
      dropped.push({ draft, ...(severity ? { severity } : {}) });
    }
  });
  const teaches = (d: { draft: StoredDraft; severity?: string }) => {
    const checkId = d.draft.drafted?.checkId;
    return checkId !== undefined && !neverQuietened(checkId) && d.severity !== undefined && d.severity !== "critical";
  };
  const signals = await learnSafely(
    dropped.filter(teaches).flatMap((d) => signalFor(d.draft, "silent_pass") ?? []),
    store,
    options,
    now,
  );
  return { dropped: dropped.map((d) => d.draft), signals };
}

/** Records the signals, or nothing if that fails: what you kept or dropped stands either way. */
async function learnSafely(
  signals: Omit<ReviewSignalInput, "at">[],
  store: ReturnType<typeof storeFrom>,
  options: { learn?: boolean },
  now: Date,
): Promise<ReviewSignalEvent[]> {
  if (signals.length === 0) return [];
  try {
    return await recordReviewSignals(signals, {
      store,
      now,
      ...(options.learn !== undefined ? { enabled: options.learn } : {}),
    });
  } catch {
    return [];
  }
}

/** "Alden drafted 3 comments — see them with `alden comment acme/shop#12`": what `alden review` says, or nothing. */
export function aldenDraftsLine(made: number, pr: string): string | undefined {
  if (made === 0) return undefined;
  return `Alden drafted ${made === 1 ? "1 comment" : `${made} comments`} — see them with \`alden comment ${pr}\``;
}
