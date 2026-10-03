import type { JsonCache } from "../cache.js";
import type { GitHubClient } from "./client.js";

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

/** Every org the token can name, and whether it can see that org's private data (one small request per org). */
export async function checkOrgAccess(client: GitHubClient): Promise<OrgAccess[]> {
  const orgs: string[] = [];
  for (let page = 1; ; page++) {
    const { data } = await client.request("GET /user/orgs", { per_page: 100, page });
    orgs.push(...data.map((o) => o.login));
    if (data.length < 100) break;
  }
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
