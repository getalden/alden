import { formatAge } from "@alden/core";
import type { Briefing, FeedbackItem, MemoryItem, RankedPullRequest, RankedQueue } from "@alden/schema";
import { sourcesText } from "../commands/memory.js";
import { otherFindings, quote, briefingMarkdown as renderMarkdown, UNTRUSTED_NOTE } from "../render/markdown.js";
import { stripControlDeep } from "../render/style.js";

export { otherFindings, UNTRUSTED_NOTE };

/**
 * Alden's output for an AI coding tool: Markdown a model reads well, with a short id on everything the reviewer might
 * react to, so "that migration flag wasn't useful" becomes one `alden_feedback` call.
 */

function queueRow(row: RankedPullRequest, n: number): string {
  const { pr } = row;
  const size = `+${pr.additions}/-${pr.deletions} in ${pr.changedFiles} file${pr.changedFiles === 1 ? "" : "s"}`;
  const flags = [row.waitingOnAuthor && "waiting on the author (CI failing)", pr.isDraft && "draft"].filter(Boolean);
  // One waiting time, on the first line, from the same number and rounding as the reason: it isn't repeated below.
  const since = pr.request.requestedAt ? "since you were asked" : "since it opened";
  const reasons = row.reasons.filter((r) => !r.startsWith("waiting "));
  return [
    `${n}. **${pr.repo}#${pr.number}** ${quote(pr.title)}`,
    `   by @${pr.author ?? "ghost"} · ${size} · waiting ${formatAge(row.waitingHours)} ${since}${flags.length ? ` · ${flags.join(", ")}` : ""}`,
    `   Why here: ${row.fastTrack ? `${row.fastTrack}; ` : ""}${reasons.join("; ") || "nothing stands out"}`,
    `   ${pr.url}`,
  ].join("\n");
}

export function queueMarkdown(untrusted: RankedQueue, limit: number): string {
  const queue = stripControlDeep(untrusted);
  const out = [`# Review queue for @${queue.viewer}`, "", UNTRUSTED_NOTE, ""];
  const lanes: [string, RankedPullRequest[], string][] = [
    ["Needs you", queue.needsYou, "ranked: blocking others first, then how long you've been asked, then risk"],
    ["Fast-track", queue.fastTrack, "small, low-risk PRs to clear quickly"],
  ];
  let n = 0;
  for (const [title, rows, about] of lanes) {
    out.push(`## ${title} (${rows.length})`, `_${about}_`, "");
    if (rows.length === 0) out.push("Nothing here.", "");
    for (const row of rows.slice(0, limit)) out.push(queueRow(row, ++n), "");
    n += Math.max(0, rows.length - limit);
    if (rows.length > limit) out.push(`…and ${rows.length - limit} more.`, "");
  }
  if (queue.dismissed?.length) out.push(`${queue.dismissed.length} dismissed PR(s) hidden until they change.`, "");
  for (const warning of queue.warnings) out.push(`> ${warning}`);
  out.push(
    "Brief one with `alden_review` (pr: `owner/repo#123`, its URL, or its number in this list). The numbers match " +
      "`alden review <n>` in the terminal.",
  );
  return out.join("\n").trimEnd();
}

/** What each id in a briefing points at, as the feedback log records it. */
export function briefingPlaces(briefing: Briefing): Map<string, FeedbackItem> {
  const places = new Map<string, FeedbackItem>();
  briefing.needsYourEyes.forEach((item, i) => {
    const severity = briefing.checks.find((c) => c.id === item.checkId)?.severity;
    places.set(`E${i + 1}`, {
      source: item.source ?? "check",
      ...(item.checkId ? { checkId: item.checkId } : {}),
      title: item.title,
      ...(severity ? { severity } : {}),
      ...(item.anchor ? { anchor: item.anchor } : {}),
      placement: "eyes",
      ...(item.fromNote ? { note: item.fromNote.id } : {}),
    });
  });
  otherFindings(briefing).forEach((finding, i) => {
    places.set(`F${i + 1}`, {
      source: "llm",
      ...(finding.checkId ? { checkId: finding.checkId } : {}),
      title: finding.title,
      severity: finding.severity,
      ...(finding.anchors[0] ? { anchor: finding.anchors[0] } : {}),
      placement: "finding",
      ...(finding.fromNote ? { note: finding.fromNote.id } : {}),
    });
  });
  for (const check of briefing.checks.filter((c) => c.status === "flagged")) {
    places.set(`C:${check.id}`, {
      source: "check",
      checkId: check.id,
      title: check.title,
      severity: check.severity,
      placement: "check",
    });
  }
  return places;
}

/** What `alden_review` returns: the briefing with an id on every place, the reviewer's memory, and how to give feedback. */
export function briefingMarkdown(untrusted: Briefing, memory: MemoryItem[], usedModel: boolean): string {
  return renderMarkdown(untrusted, { forModel: { memory, usedModel } });
}

export function memoryMarkdown(repo: string, untrusted: MemoryItem[], paused: boolean): string {
  const items = stripControlDeep(untrusted);
  const out = [`# What Alden knows about the reviewer in ${repo}`, ""];
  if (paused) out.push("Learning is paused here: this is kept but not applied.", "");
  if (items.length === 0) {
    out.push(
      "Nothing yet. Alden learns from what the reviewer marks useful or not useful, and from notes (`alden_remember`).",
    );
    return out.join("\n");
  }
  for (const [title, group] of [
    ["What they look for", "look"],
    ["What they skip", "skip"],
  ] as const) {
    const list = items.filter((i) => i.group === group);
    if (list.length === 0) continue;
    out.push(`## ${title}`);
    for (const item of list) {
      const effect = item.effect?.replace(/\.$/, "");
      const reviews = (item.sources ?? []).filter((source) => source.from === "review" || source.from === "outcome");
      const detail = [
        item.source === "you" ? "they said" : item.evidence,
        item.confirmed && `confirmed ${item.confirmed}×`,
        reviews.length > 0 && `from ${sourcesText(reviews)}`,
        effect && effect.charAt(0).toLowerCase() + effect.slice(1),
      ].filter(Boolean);
      out.push(`- ${quote(item.text)} (${detail.join("; ")}; since ${item.since.slice(0, 10)})`);
    }
    out.push("");
  }
  out.push(
    "The reviewer can edit or forget any of this with `alden memory` in a terminal or the Memory view in `alden ui`.",
  );
  return out.join("\n").trimEnd();
}
