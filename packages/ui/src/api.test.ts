// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Api, type ReviewEvent, takeChosenFolder, takeToken } from "./api";
import { parseRoute, routePath } from "./router";

afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("takeToken", () => {
  it("takes the token from the fragment, keeps it for the tab and clears it from the address bar", () => {
    window.history.replaceState(null, "", "/pr/a/b/1#t=abc_DEF-123");
    expect(takeToken()).toBe("abc_DEF-123");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/pr/a/b/1");
    // A reload has no fragment, but the tab remembers.
    expect(takeToken()).toBe("abc_DEF-123");
  });

  it("has nothing without a link", () => {
    expect(takeToken()).toBeUndefined();
  });

  it("notices the desktop app restarted Alden in a folder you chose, and still takes the token", () => {
    window.history.replaceState(null, "", "/#t=abc&folder=chosen");
    expect(takeChosenFolder()).toBe(true);
    expect(takeToken()).toBe("abc");
    expect(takeChosenFolder()).toBe(false);
  });
});

/** A fetch that answers with a stream split at awkward places, as a network would. */
function streaming(chunks: string[], status = 200): typeof fetch {
  return async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }),
      { status, headers: { "Content-Type": "application/x-ndjson" } },
    );
}

describe("Api.review", () => {
  const briefing = { target: { kind: "local" }, files: [] };

  it("reports stages and resolves with the briefing, however the stream is split", async () => {
    const lines = [
      JSON.stringify({ type: "stage", stage: "fetch", label: "Reading" }),
      JSON.stringify({ type: "stage", stage: "checks", label: "Checking" }),
      JSON.stringify({ type: "briefing", briefing }),
    ].join("\n");
    const events: ReviewEvent[] = [];
    const api = new Api("t", streaming([lines.slice(0, 10), lines.slice(10, 61), `${lines.slice(61)}\n`]));
    await expect(api.review({}, (e) => events.push(e))).resolves.toEqual(briefing);
    expect(events.map((e) => e.type)).toEqual(["stage", "stage", "briefing"]);
  });

  it("rejects with the server's message on an error event or a failed start", async () => {
    const failing = new Api("t", streaming([`${JSON.stringify({ type: "error", message: "Not a PR." })}\n`]));
    await expect(failing.review({ pr: "x" }, () => {})).rejects.toThrow("Not a PR.");

    const refused = new Api("t", async () => new Response(JSON.stringify({ error: "Wrong host." }), { status: 403 }));
    await expect(refused.review({}, () => {})).rejects.toThrow("Wrong host.");
  });

  it("sends the session token on every call", async () => {
    let seen: string | null = null;
    const api = new Api("secret", async (_url, init) => {
      seen = new Headers(init?.headers).get("X-Alden-Token");
      return new Response("{}");
    });
    await api.session();
    expect(seen).toBe("secret");
  });
});

describe("routes", () => {
  it("round-trips PRs, local changes and settings", () => {
    for (const path of ["/", "/pr/getalden/alden/12", "/local", "/stats", "/settings"]) {
      expect(routePath(parseRoute(path))).toBe(path);
    }
    expect(parseRoute("/pr/a/b/not-a-number")).toEqual({ view: "queue" });
  });
});

describe("Api.diff", () => {
  it("asks for a PR's diff by owner/repo#number, with the session token", async () => {
    const seen: { url: string; token: string | null }[] = [];
    const api = new Api("t", async (input, init) => {
      seen.push({ url: String(input), token: new Headers(init?.headers).get("X-Alden-Token") });
      return new Response(JSON.stringify({ headSha: "abc", files: [] }), { status: 200 });
    });
    await expect(api.diff("acme/api#12")).resolves.toEqual({ headSha: "abc", files: [] });
    expect(seen).toEqual([{ url: "/api/diff?pr=acme%2Fapi%2312", token: "t" }]);
    expect(new URLSearchParams(seen[0]?.url.split("?")[1]).get("pr")).toBe("acme/api#12");
  });
});
