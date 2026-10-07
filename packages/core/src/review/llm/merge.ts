import type { CheckResult, LlmFinding, LookHere, Severity } from "@alden/schema";
import { isLockfile } from "../../queue/files.js";
import { isSevere, MAX_LOOK_HERE } from "../pick.js";

const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** A finding's slot: its first anchor on a file nobody has claimed, or none if it has no place. */
function fromFinding(finding: LlmFinding, used: Set<string>): LookHere | undefined {
  const anchor = finding.anchors.find((a) => !used.has(a.path) && !isLockfile(a.path));
  if (!anchor) return undefined;
  const more =
    finding.anchors.length > 1
      ? ` (and ${finding.anchors.length - 1} more place${finding.anchors.length > 2 ? "s" : ""})`
      : "";
  return {
    title: finding.title,
    reason: `${finding.detail}${more}`,
    anchor,
    source: "llm",
    ...(finding.checkId ? { checkId: finding.checkId } : {}),
    ...(finding.fromNote ? { fromNote: finding.fromNote } : {}),
  };
}

/**
 * The final places to look (`max` of them, three unless `review.eyes` says otherwise). Deterministic high and critical picks (secrets, destructive migrations) always keep
 * their slots; then the model's findings, most severe first; then the remaining deterministic picks. One slot per file.
 */
export function mergeLookHere(
  deterministic: LookHere[],
  checks: CheckResult[],
  findings: LlmFinding[],
  max: number = MAX_LOOK_HERE,
): LookHere[] {
  const severityOf = (item: LookHere): Severity => checks.find((c) => c.id === item.checkId)?.severity ?? "info";
  const withSource = deterministic.map((item) => ({ ...item, source: item.source ?? ("check" as const) }));

  const picked: LookHere[] = [];
  const used = new Set<string>();
  const take = (item: LookHere | undefined) => {
    if (!item || picked.length >= max) return;
    if (item.anchor) {
      if (used.has(item.anchor.path)) return;
      used.add(item.anchor.path);
    }
    picked.push(item);
  };

  for (const item of withSource.filter((i) => isSevere(severityOf(i)))) take(item);
  const ranked = [...findings]
    .filter((f) => f.severity !== "low" && f.severity !== "info")
    .sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  for (const finding of ranked) take(fromFinding(finding, used));
  for (const item of withSource.filter((i) => !isSevere(severityOf(i)))) take(item);
  return picked;
}
