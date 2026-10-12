import { describe, expect, it } from "vitest";
import { signOut } from "./setup.js";

describe("signOut", () => {
  it("removes Alden's stored token and says what still signs you in", async () => {
    let deleted = 0;
    const store = {
      delete: async () => {
        deleted += 1;
      },
    };
    expect(await signOut(store, async () => ({ source: "gh" }))).toEqual({ remaining: "Your GitHub CLI sign-in" });
    expect(await signOut(store, async () => ({ source: "env" }))).toEqual({ remaining: "ALDEN_GITHUB_TOKEN" });
    expect(await signOut(store, async () => undefined)).toEqual({ remaining: null });
    expect(deleted).toBe(3);
  });

  it("still signs out when finding what's left fails", async () => {
    const result = await signOut({ delete: async () => {} }, async () => {
      throw new Error("keychain locked");
    });
    expect(result).toEqual({ remaining: null });
  });
});
