import { describe, expect, it } from "vitest";
import type { GitHubClient } from "./client.js";
import { checkOrgAccess, orgAccessFromError, orgAccessWarnings, orgInScope } from "./orgs.js";

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const SSO =
  "Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.";
const RESTRICTED =
  "Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.";

/** `listed`: the orgs the token's own list includes (all of them unless given). */
function fakeClient(orgs: Record<string, Error | null>, listed = Object.keys(orgs)): GitHubClient {
  return {
    request: async (route: string, params: { org?: string; page?: number } = {}) => {
      if (route === "GET /user") return { data: { login: "me" } };
      if (route === "GET /users/{username}/orgs") return { data: [] };
      if (route === "GET /user/orgs") return { data: params.page === 1 ? listed.map((login) => ({ login })) : [] };
      const error = orgs[params.org ?? ""];
      if (error) throw error;
      return { data: [] };
    },
  } as unknown as GitHubClient;
}

describe("org access", () => {
  it("tells single sign-on and app restrictions apart from other failures", () => {
    expect(orgAccessFromError(fail(403, SSO))).toBe("sso");
    expect(orgAccessFromError(fail(403, RESTRICTED))).toBe("restricted");
    expect(orgAccessFromError(fail(403, "Must have admin rights to Repository."))).toBe("unknown");
    expect(orgAccessFromError(fail(500, SSO))).toBe("unknown");
  });

  it("checks every org, and warns only about the ones that hide their PRs", async () => {
    const access = await checkOrgAccess(
      fakeClient({ acme: fail(403, SSO), acme: fail(403, RESTRICTED), getalden: null }),
      { otherOrgs: async () => [] },
    );
    expect(access).toEqual([
      { org: "acme", access: "sso" },
      { org: "acme", access: "restricted" },
      { org: "getalden", access: "ok" },
    ]);
    const warnings = orgAccessWarnings(access);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("acme uses single sign-on");
    expect(warnings[1]).toContain("acme restricts third-party apps");
  });

  it("finds orgs that leave themselves out of this sign-in's own list, through the GitHub CLI's", async () => {
    const client = fakeClient({ acme: fail(403, RESTRICTED), getalden: null }, ["getalden"]);
    const access = await checkOrgAccess(client, { otherOrgs: async () => ["acme", "getalden"] });
    expect(access).toEqual([
      { org: "getalden", access: "ok" },
      { org: "acme", access: "restricted" },
    ]);
  });

  it("counts an org in scope when nothing is set, when named, or when it owns a named repo, never when ignored", () => {
    expect(orgInScope("acme", {})).toBe(true);
    expect(orgInScope("acme", { orgs: ["getalden"] })).toBe(false);
    expect(orgInScope("Acme", { repos: ["acme/web"] })).toBe(true);
    expect(orgInScope("acme", { ignore: ["acme"] })).toBe(false);
  });
});
