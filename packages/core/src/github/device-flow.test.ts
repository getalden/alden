import { describe, expect, it } from "vitest";
import { type DeviceCode, githubClientId, pollForToken, requestDeviceCode } from "./device-flow.js";

const code: DeviceCode = {
  deviceCode: "dc",
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  expiresIn: 900,
  interval: 5,
};

function fakeFetch(responses: Record<string, unknown>[]) {
  const bodies: unknown[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = responses.shift() ?? {};
    return new Response(JSON.stringify(next), { status: 200 });
  }) as typeof fetch;
  return { impl, bodies };
}

describe("device flow", () => {
  it("parses the device code response", async () => {
    const { impl, bodies } = fakeFetch([
      {
        device_code: "dc",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      },
    ]);
    expect(await requestDeviceCode("cid", { fetch: impl })).toEqual(code);
    expect(bodies[0]).toEqual({ client_id: "cid", scope: "repo read:org" });
  });

  it("waits through pending and slow_down, then returns the token", async () => {
    const waits: number[] = [];
    const { impl } = fakeFetch([
      { error: "authorization_pending" },
      { error: "slow_down", interval: 10 },
      { access_token: "gho_abc" },
    ]);
    const token = await pollForToken("cid", code, {
      fetch: impl,
      sleep: async (ms) => {
        waits.push(ms);
      },
      now: () => 0,
    });
    expect(token).toBe("gho_abc");
    expect(waits).toEqual([5000, 5000, 10000]);
  });

  it("explains a cancelled sign-in", async () => {
    const { impl } = fakeFetch([{ error: "access_denied" }]);
    await expect(pollForToken("cid", code, { fetch: impl, sleep: async () => {}, now: () => 0 })).rejects.toThrow(
      /cancelled/,
    );
  });

  it("gives up when the code expires", async () => {
    let t = 0;
    const { impl } = fakeFetch(Array(1000).fill({ error: "authorization_pending" }));
    await expect(
      pollForToken("cid", code, {
        fetch: impl,
        sleep: async (ms) => {
          t += ms;
        },
        now: () => t,
      }),
    ).rejects.toThrow(/expired/);
  });

  it("points to the GitHub CLI when no client ID is configured", () => {
    expect(() => githubClientId({})).toThrow(/gh auth login/);
    expect(githubClientId({ ALDEN_GITHUB_CLIENT_ID: "Iv1.test" })).toBe("Iv1.test");
  });
});
