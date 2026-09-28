import { describe, expect, it } from "vitest";
import type { CredentialStore } from "./credentials.js";
import { resolveToken } from "./token.js";

function store(token?: string): CredentialStore {
  return { get: async () => token, set: async () => {}, delete: async () => {} };
}

describe("resolveToken", () => {
  it("prefers ALDEN_GITHUB_TOKEN", async () => {
    const result = await resolveToken({
      env: { ALDEN_GITHUB_TOKEN: "env-token" },
      store: store("stored"),
      ghToken: async () => "gh",
    });
    expect(result).toEqual({ token: "env-token", source: "env" });
  });

  it("uses the stored token before the GitHub CLI's", async () => {
    const result = await resolveToken({ env: {}, store: store("stored"), ghToken: async () => "gh" });
    expect(result).toEqual({ token: "stored", source: "alden" });
  });

  it("falls back to the GitHub CLI", async () => {
    const result = await resolveToken({ env: {}, store: store(), ghToken: async () => "gh" });
    expect(result).toEqual({ token: "gh", source: "gh" });
  });

  it("ignores GITHUB_TOKEN and returns undefined when nothing is signed in", async () => {
    const result = await resolveToken({
      env: { GITHUB_TOKEN: "actions" },
      store: store(),
      ghToken: async () => undefined,
    });
    expect(result).toBeUndefined();
  });
});
