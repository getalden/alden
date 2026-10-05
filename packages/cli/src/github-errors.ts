import type { TokenSource } from "@alden/core";

const SOURCE: Record<TokenSource, string> = {
  env: "ALDEN_GITHUB_TOKEN",
  alden: "Alden's saved GitHub sign-in",
  gh: "your GitHub CLI sign-in",
};

const FIX: Record<TokenSource, string> = {
  env: "Fix or unset ALDEN_GITHUB_TOKEN.",
  alden:
    "It may have been revoked. Run `alden auth login --device` to sign in again, or `alden auth logout` to use your GitHub CLI sign-in instead.",
  gh: "Run `gh auth login` to refresh it, or `alden auth login --device` to sign in to Alden directly.",
};

/** Turns GitHub API failures into something the user can act on; other errors keep their message. */
export function describeGitHubError(error: unknown, source: TokenSource): string {
  const status = (error as { status?: number }).status;
  if (status === 401) return `GitHub rejected ${SOURCE[source]}. ${FIX[source]}`;
  if (status === 403 && /rate limit/i.test((error as Error).message)) {
    return "GitHub's rate limit is used up for now. Try again in a few minutes.";
  }
  if (status === 403) {
    return `GitHub refused access using ${SOURCE[source]}. The token may lack the repo or read:org scope, or an organisation may restrict OAuth apps.`;
  }
  return error instanceof Error ? error.message : String(error);
}

const REVIEW_FIX: Record<TokenSource, string> = {
  env: 'A classic token in ALDEN_GITHUB_TOKEN needs the repo scope; a fine-grained one needs "Pull requests: Read and write" on this repo.',
  alden:
    "Alden's sign-in has the repo scope, which covers reviews, so the organisation may restrict OAuth apps: ask an admin to approve Alden, or sign in again with `alden auth login --device`.",
  gh: "Run `gh auth refresh -s repo`, or sign in to Alden directly with `alden auth login --device`.",
};

/** What to do when GitHub won't take a review from this sign-in. */
export function reviewWriteFix(source: TokenSource): string {
  return REVIEW_FIX[source];
}
