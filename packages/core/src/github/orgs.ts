import type { JsonCache } from "../cache.js";
import { createGitHubClient, type GitHubClient } from "./client.js";
import { ghCliToken } from "./token.js";

/**
 * Whether a sign-in can see an organization's private data. Orgs can hide it from a token two ways, and GitHub's
 * search then leaves their PRs out without an error, so the queue just looks short:
 * - "sso": the org uses SAML single sign-on and this token hasn't been authorized for it;
 * - "restricted": the org restricts OAuth apps and hasn't approved the app the token came from.
 */
export type OrgAccessState = "ok" | "sso" | "restricted" | "unknown";

export interface OrgAccess {
  org: string;
  access: OrgAccessState;
}

const SSO = /SAML enforcement|single sign-on|SSO/i;
const RESTRICTED = /OAuth App access restrictions/i;

/** Classifies an error from GitHub for an org endpoint. */
export function orgAccessFromError(error: unknown): OrgAccessState {
  const status = (error as { status?: number }).status;
  const message = (error as { message?: string }).message ?? "";
  if (status === 403 && SSO.test(message)) return "sso";
  if (status === 403 && RESTRICTED.test(message)) return "restricted";
  return "unknown";
}

async function userOrgs(client: GitHubClient): Promise<string[]> {
  const orgs: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await client.request("GET /user/orgs", { per_page: 100, page });
    orgs.push(...data.map((o) => o.login));
    if (data.length < 100) break;
  }
  return orgs;
}

/**
 * Your orgs, and whether this token can see each one's private data (one small request per org).
 *
 * An org that hides itself from a token is often missing from that token's own list of orgs too, so the list also
 * takes your public memberships and the orgs the GitHub CLI's sign-in can see, when it's signed in (`otherOrgs`).
 */
export async function checkOrgAccess(
  client: GitHubClient,
  options: { otherOrgs?: () => Promise<string[]> } = {},
): Promise<OrgAccess[]> {
  const mine = await userOrgs(client);
  const { data: user } = await client.request("GET /user");
  const [publicOrgs, otherOrgs] = await Promise.all([
    client
      .request("GET /users/{username}/orgs", { username: user.login, per_page: 100 })
      .then(({ data }) => data.map((o) => o.login))
      .catch(() => [] as string[]),
    (options.otherOrgs ?? gitHubCliOrgs)().catch(() => [] as string[]),
  ]);
  const seen = new Set<string>();
  const orgs = [...mine, ...publicOrgs, ...otherOrgs].filter((org) => {
    const key = org.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return Promise.all(
    orgs.map(async (org): Promise<OrgAccess> => {
      try {
        // Teams are private to the org: a token the org hides its data from gets a 403 that says why.
        await client.request("GET /orgs/{org}/teams", { org, per_page: 1 });
        return { org, access: "ok" };
      } catch (error) {
        return { org, access: orgAccessFromError(error) };
      }
    }),
  );
}

/** The orgs the GitHub CLI's sign-in lists, if it's signed in. */
async function gitHubCliOrgs(): Promise<string[]> {
  const token = await ghCliToken();
  return token ? userOrgs(createGitHubClient(token)) : [];
}

/** `checkOrgAccess`, remembered for an hour per account, for the queue (doctor always checks afresh). */
export async function cachedOrgAccess(client: GitHubClient, login: string, cache?: JsonCache): Promise<OrgAccess[]> {
  const key = `org-access:v1:${login}`;
  const cached = await cache?.get<OrgAccess[]>(key, 3_600_000);
  if (cached) return cached;
  const access = await checkOrgAccess(client);
  await cache?.set(key, access);
  return access;
}

/** What the queue says about orgs whose PRs it can't see. */
export function orgAccessWarnings(access: OrgAccess[]): string[] {
  return access.flatMap(({ org, access: state }) =>
    state === "sso"
      ? [
          `${org} uses single sign-on and this sign-in isn't authorized for it, so its PRs are missing. Run \`alden doctor\` to see how to fix it.`,
        ]
      : state === "restricted"
        ? [
            `${org} restricts third-party apps and hasn't approved this sign-in, so its private PRs are missing. Run \`alden doctor\` to see how to fix it.`,
          ]
        : [],
  );
}
