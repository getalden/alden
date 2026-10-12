import { type AldenConfig, DRAFT_TONES, type DraftTone, type ToneState } from "@alden/schema";
import { type StoreSource, storeFrom } from "../store/source.js";

/**
 * The tone of the comments Alden drafts: `drafts.tone` in your user config (concise unless you change it), or a
 * repo's own, kept on this machine in the database's `meta` table. It's a preference you set, not something Alden
 * learns, so it isn't in the repo's memory and nothing ever changes it but you.
 */

const KEY = (repo: string) => `drafts.tone:${repo.toLowerCase()}`;

export const isDraftTone = (value: unknown): value is DraftTone =>
  typeof value === "string" && (DRAFT_TONES as readonly string[]).includes(value);

/** A repo's own tone, or undefined when it follows the global `drafts.tone`. */
export function repoTone(repo: string, store?: StoreSource): DraftTone | undefined {
  const value = storeFrom(store).get<{ value: string }>("SELECT value FROM meta WHERE key = ?", KEY(repo))?.value;
  return isDraftTone(value) ? value : undefined;
}

/** Sets a repo's own tone; null removes it, so the global `drafts.tone` applies again. */
export function setRepoTone(repo: string, tone: DraftTone | null, store?: StoreSource): void {
  const db = storeFrom(store);
  if (tone === null) db.run("DELETE FROM meta WHERE key = ?", KEY(repo));
  else
    db.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      KEY(repo),
      tone,
    );
}

/**
 * The tone Alden drafts in for a repo, and where it comes from: the repo's own when it has one, else `drafts.tone`.
 * Without a repo (local changes), the global one. A database that can't be read falls back to the global one too.
 */
export function toneFor(repo: string | undefined, config: AldenConfig, store?: StoreSource): ToneState {
  if (repo) {
    try {
      const own = repoTone(repo, store);
      if (own) return { tone: own, source: "repo" };
    } catch {
      // the database is locked or damaged: the global tone still applies
    }
  }
  return { tone: config.drafts.tone, source: "default" };
}

/**
 * What each tone asks of a comment, in the system prompt of every drafting call. Concise is the wording Alden's
 * prompts always had. Each keeps the rules around it (no preamble or praise, never approve, never mention being an
 * AI): only the length and how much reasoning goes in change.
 */
export const TONE_INSTRUCTIONS: Record<DraftTone, string> = {
  terse:
    "Tone: terse. Write each comment as one short line, a statement or a question: the problem and, when it isn't obvious, the fix. No reasoning, no background, no examples.",
  concise:
    "Tone: concise. Write each comment in one to three plain sentences: what's wrong or worth checking, and what to do.",
  detailed:
    "Tone: detailed. Write each comment as a short paragraph of three to six plain sentences: what's wrong, why it matters (the impact: what breaks, for whom, when), and a concrete fix, pointing at what in the diff shows it.",
  teaching:
    "Tone: teaching, for a teammate newer to this code or technology. Write each comment in three to six plain, friendly sentences: name the general principle or pattern at stake, say briefly why it matters here, and show the usual way to do it, pointing at an example in the diff or the repository when there is one. Explain without talking down.",
};

/** The tone's instruction, for a system prompt. */
export const toneInstruction = (tone: DraftTone = "concise"): string => TONE_INSTRUCTIONS[tone];
