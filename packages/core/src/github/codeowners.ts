import ignore from "ignore";

export interface CodeownersRule {
  pattern: string;
  owners: string[];
  matches: (path: string) => boolean;
}

/** Where GitHub looks for CODEOWNERS, in the order it checks them. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern) continue;
    const matcher = ignore().add(pattern);
    rules.push({ pattern, owners, matches: (path) => matcher.ignores(path) });
  }
  return rules;
}

/** Owners of a path. As on GitHub, the last matching rule wins, and a rule with no owners clears ownership. */
export function ownersOf(rules: CodeownersRule[], path: string): string[] {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (rule?.matches(path)) return rule.owners;
  }
  return [];
}

/**
 * Whether the viewer owns a path, directly (`@login`) or through a team (`@org/slug`).
 * `teams` holds the viewer's teams as lowercase `org/slug`.
 */
export function isOwner(owners: string[], login: string, teams: ReadonlySet<string>): boolean {
  const me = `@${login.toLowerCase()}`;
  return owners.some((owner) => {
    const o = owner.toLowerCase();
    return o === me || (o.includes("/") && teams.has(o.slice(1)));
  });
}
