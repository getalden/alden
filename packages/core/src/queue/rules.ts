import { DEFAULT_RULE_POINTS, type RankRule, type RankRuleWhen, type ScoreLine } from "@alden/schema";
import picomatch from "picomatch";
import type { PullRequestFacts } from "../github/pull-requests.js";
import { loginSlug, prAuthor } from "../learn/authors.js";

/**
 * Your ranking rules (`[[queue.rank.rules]]`): "PRs touching payments/ first", "bots last", "boost the security
 * label". They apply after learning, and learning never overrides them: a first or last rule orders the lane before
 * any score does, and learning that pulls against a boost or lower rule is set aside.
 */

const GLOB = /[*?[\]{}!]/;

/** A plain "payments/" or "src/app.ts" means that folder or file anywhere; anything with glob characters is a glob. */
export function pathGlobs(pattern: string): string[] {
  const trimmed = pattern.trim().replace(/^\.?\/+/, "");
  if (GLOB.test(trimmed)) return [trimmed];
  const plain = trimmed.replace(/\/+$/, "");
  return [plain, `${plain}/**`, `**/${plain}`, `**/${plain}/**`];
}

type Matcher = (pr: PullRequestFacts, viewer: string | undefined) => boolean;

const compiled = new WeakMap<RankRuleWhen, Matcher>();

function authorMatcher(value: string): Matcher {
  const wanted = value.trim().replace(/^@/, "").toLowerCase();
  return (pr, viewer) => {
    const author = prAuthor(pr, viewer);
    if (!author) return false;
    if (wanted === "people") return author.kind === "person";
    if (wanted === "bots") return author.kind === "bot";
    if (wanted === "agents") return author.kind === "agent";
    const slug = loginSlug(wanted);
    return (pr.author !== null && loginSlug(pr.author) === slug) || author.id === slug || author.person === slug;
  };
}

/** Every condition the rule gives must hold. */
function matcher(when: RankRuleWhen): Matcher {
  const cached = compiled.get(when);
  if (cached) return cached;
  const checks: Matcher[] = [];
  if (when.path !== undefined) {
    const isMatch = picomatch(pathGlobs(when.path), { dot: true, nocase: true });
    checks.push((pr) => pr.files.some((f) => isMatch(f.path)));
  }
  if (when.label !== undefined) {
    const label = when.label.trim().toLowerCase();
    checks.push((pr) => pr.labels.some((l) => l.toLowerCase() === label));
  }
  if (when.author !== undefined) checks.push(authorMatcher(when.author));
  if (when.repo !== undefined) {
    const repo = when.repo.toLowerCase();
    checks.push((pr) => {
      const name = pr.repo.toLowerCase();
      return repo.includes("/") ? name === repo : name.startsWith(`${repo}/`);
    });
  }
  if (when.base !== undefined) {
    const isBase = picomatch(when.base.trim(), { dot: true });
    checks.push((pr) => isBase(pr.baseRef));
  }
  if (when.title !== undefined) {
    const text = when.title.toLowerCase();
    checks.push((pr) => pr.title.toLowerCase().includes(text));
  }
  const match: Matcher = (pr, viewer) => checks.length > 0 && checks.every((check) => check(pr, viewer));
  compiled.set(when, match);
  return match;
}

export function ruleMatches(rule: RankRule, pr: PullRequestFacts, viewer?: string): boolean {
  return matcher(rule.when)(pr, viewer);
}

const AUTHOR_KINDS: Record<string, string> = { people: "people", bots: "bots", agents: "AI agents" };

/** What a rule matches, as a row says it: "payments/", "labelled security", "bots", "into release/*". */
export function describeWhen(when: RankRuleWhen): string {
  const parts: string[] = [];
  if (when.path !== undefined) parts.push(when.path);
  if (when.label !== undefined) parts.push(`labelled ${when.label}`);
  if (when.author !== undefined) {
    const author = when.author.trim().replace(/^@/, "");
    parts.push(AUTHOR_KINDS[author.toLowerCase()] ?? `@${author}`);
  }
  if (when.repo !== undefined) parts.push(when.repo);
  if (when.base !== undefined) parts.push(`into ${when.base}`);
  if (when.title !== undefined) parts.push(`"${when.title}" in title`);
  return parts.join(" and ");
}

export const rulePoints = (rule: RankRule): number => rule.by ?? DEFAULT_RULE_POINTS;

/** "↑ your rule: payments/ first", "↓ your rule: bots last", "↑ your rule: labelled security +5". */
export function ruleReason(rule: RankRule): string {
  const up = rule.then === "first" || rule.then === "boost";
  const what = rule.name ?? describeWhen(rule.when);
  const effect =
    rule.then === "first" || rule.then === "last"
      ? rule.then
      : `${rule.then === "boost" ? "+" : "−"}${rulePoints(rule)}`;
  return `${up ? "↑" : "↓"} your rule: ${what} ${effect}`;
}

export interface AppliedRules {
  /** The first matching first or last rule decides; later ones that disagree don't apply. */
  pinned?: "first" | "last";
  /** Boost and lower points, all matching rules added up. */
  points: number;
  lines: ScoreLine[];
  reasons: string[];
}

/** The rules that match a PR, in the order you listed them. */
export function applyRules(rules: RankRule[], pr: PullRequestFacts, viewer?: string): AppliedRules {
  const applied: AppliedRules = { points: 0, lines: [], reasons: [] };
  for (const rule of rules) {
    if (!ruleMatches(rule, pr, viewer)) continue;
    if (rule.then === "first" || rule.then === "last") {
      if (applied.pinned !== undefined) continue;
      applied.pinned = rule.then;
      applied.lines.push({ signal: "rule", points: 0, text: ruleReason(rule) });
    } else {
      const points = rule.then === "boost" ? rulePoints(rule) : -rulePoints(rule);
      applied.points += points;
      applied.lines.push({ signal: "rule", points, text: ruleReason(rule) });
    }
    applied.reasons.push(ruleReason(rule));
  }
  return applied;
}
