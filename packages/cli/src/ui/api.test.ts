import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RankedQueue } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { createUiApi, nextToPrepare, saveToDownloads } from "./api.js";

const row = (number: number, extra: { draft?: boolean; onAuthor?: boolean; updatedAt?: string } = {}) =>
  ({
    pr: { repo: "a/b", number, isDraft: extra.draft ?? false, updatedAt: extra.updatedAt ?? "2026-10-01T00:00:00Z" },
    waitingOnAuthor: extra.onAuthor ?? false,
  }) as unknown as RankedQueue["needsYou"][number];
const queue = (...rows: RankedQueue["needsYou"]) => ({ needsYou: rows, fastTrack: [] }) as unknown as RankedQueue;

describe("nextToPrepare", () => {
  it("takes the first of the top three that's ready for review and not yet briefed", () => {
    const q = queue(row(1, { draft: true }), row(2, { onAuthor: true }), row(3), row(4));
    expect(nextToPrepare(q, () => undefined)?.pr.number).toBe(3);
  });

  it("briefs a PR again once it has changed, and leaves the rest of the queue alone", () => {
    const q = queue(row(1), row(2, { updatedAt: "2026-10-02T00:00:00Z" }), row(3), row(4));
    const done = (_: string, n: number) => (n === 2 ? "2026-10-01T00:00:00Z" : "2026-10-01T00:00:00Z");
    expect(nextToPrepare(q, done)?.pr.number).toBe(2);
    expect(nextToPrepare(queue(row(1), row(2), row(3), row(4)), () => "2026-10-01T00:00:00Z")).toBeUndefined();
  });
});

describe("nextToPrepare and background.prepare", () => {
  it("keeps as many of the top PRs briefed as you ask, in the ranked order", () => {
    const q = queue(row(1), row(2), row(3), row(4), row(5));
    const done = (_: string, n: number) => (n <= 3 ? "2026-10-01T00:00:00Z" : undefined);
    expect(nextToPrepare(q, done)).toBeUndefined();
    expect(nextToPrepare(q, done, 5)?.pr.number).toBe(4);
    expect(nextToPrepare(q, () => undefined, 0)).toBeUndefined();
  });
});

describe("feedback through the UI's API", () => {
  it("says how close each useful or not useful brought a lesson", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { closeStores } = await import("@alden/core");
    const { createUiApi } = await import("./api.js");
    const home = mkdtempSync(join(tmpdir(), "alden-api-"));
    const saved = { home: process.env.ALDEN_HOME, track: process.env.DO_NOT_TRACK };
    process.env.ALDEN_HOME = home;
    process.env.DO_NOT_TRACK = "1";
    try {
      const api = createUiApi({ version: "test", cwd: home });
      const verdict = (number: number, checkId: string) =>
        api.addFeedback({
          kind: "verdict",
          target: { kind: "pr", repo: "acme/shop", number },
          briefingAt: "2026-10-01T00:00:00.000Z",
          item: { source: "check", checkId, title: "t", placement: "eyes" },
          verdict: "not_needed",
        }) as Promise<{ progress?: string }>;
      expect((await verdict(1, "signatures.changed")).progress).toBe(
        "1 of 3: 2 more not useful on API change flags (public signature and caller flags count together) and Alden will quieten them.",
      );
      expect((await verdict(2, "callers.outside")).progress).toMatch(/^2 of 3: one more not useful/);
      expect((await verdict(3, "callers.outside")).progress).toBe(
        "3 of 3 not useful on API change flags (public signature and caller flags count together): Alden quietens them in this repo.",
      );
    } finally {
      closeStores();
      process.env.ALDEN_HOME = saved.home;
      if (saved.home === undefined) delete process.env.ALDEN_HOME;
      if (saved.track === undefined) delete process.env.DO_NOT_TRACK;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("a finding from your note, through the UI's API", () => {
  it("confirms the note on useful, teaches no check, and stops the note under a folder", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { closeStores } = await import("@alden/core");
    const home = mkdtempSync(join(tmpdir(), "alden-api-note-"));
    const saved = { home: process.env.ALDEN_HOME, track: process.env.DO_NOT_TRACK };
    process.env.ALDEN_HOME = home;
    process.env.DO_NOT_TRACK = "1";
    try {
      const api = createUiApi({ version: "test", cwd: home });
      const added = (await api.addMemory({ repo: "acme/shop", text: "Every file needs a code owner header" })) as {
        items: { id: string }[];
      };
      const id = added.items[0]?.id as string;
      const verdict = (number: number, v: "agree" | "not_needed") =>
        api.addFeedback({
          kind: "verdict",
          target: { kind: "pr", repo: "acme/shop", number },
          briefingAt: "2026-10-01T00:00:00.000Z",
          item: {
            source: "llm",
            checkId: "tests.missing",
            title: "Missing code owner header",
            anchor: { path: "app/api/users/route.ts" },
            placement: "finding",
            note: id,
          },
          verdict: v,
        }) as Promise<{ progress?: string }>;
      expect((await verdict(1, "agree")).progress).toBe("Saved. Your note is confirmed 1×.");
      expect((await verdict(2, "agree")).progress).toBe("Saved. Your note is confirmed 2×.");
      expect((await verdict(3, "not_needed")).progress).toMatch(/^Saved\. This came from your note/);
      const memory = (await api.changeMemory({ repo: "acme/shop", action: "exclude", id, path: "app/api" })) as {
        items: { id: string; confirmed?: number; excluded?: string[] }[];
      };
      // Only the note: no check lesson came from these reactions.
      expect(memory.items).toMatchObject([{ id, confirmed: 2, excluded: ["app/api"] }]);
      await expect(api.changeMemory({ repo: "acme/shop", action: "include", id, path: "lib" })).rejects.toThrow(
        "That note isn't stopped under lib.",
      );
      await expect(
        api.changeMemory({ repo: "acme/shop", action: "exclude", id: "note:nope", path: "lib" }),
      ).rejects.toThrow("No note called note:nope in acme/shop.");
    } finally {
      closeStores();
      process.env.ALDEN_HOME = saved.home;
      if (saved.home === undefined) delete process.env.ALDEN_HOME;
      if (saved.track === undefined) delete process.env.DO_NOT_TRACK;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("saveToDownloads", () => {
  it("never replaces a file: a second save of the same PR gets -2", async () => {
    const folder = await mkdtemp(join(tmpdir(), "alden-downloads-"));
    try {
      const first = await saveToDownloads("a-b-1-briefing.md", "one", folder);
      const second = await saveToDownloads("a-b-1-briefing.md", "two", folder);
      expect(first.path).toBe(join(folder, "a-b-1-briefing.md"));
      expect(second.path).toBe(join(folder, "a-b-1-briefing-2.md"));
      expect(await readFile(first.path, "utf8")).toBe("one");
      expect(await readFile(second.path, "utf8")).toBe("two");
      expect((await readdir(folder)).sort()).toEqual(["a-b-1-briefing-2.md", "a-b-1-briefing.md"]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("saves the redacted feedback export to Downloads in the desktop app", async () => {
    const home = await mkdtemp(join(tmpdir(), "alden-home-"));
    const downloads = await mkdtemp(join(tmpdir(), "alden-downloads-"));
    process.env.ALDEN_HOME = home;
    try {
      const api = createUiApi({ version: "0", cwd: home, desktop: true, downloads });
      const saved = await api.saveFeedback();
      expect(saved.events).toBe(0);
      expect(JSON.parse(await readFile(saved.path, "utf8"))).toEqual([]);
      expect(saved.path.startsWith(downloads)).toBe(true);
    } finally {
      delete process.env.ALDEN_HOME;
      // Windows can't delete the database while this process still has it open; the OS clears its temp folder.
      await rm(home, { recursive: true, force: true }).catch(() => {});
      await rm(downloads, { recursive: true, force: true });
    }
  });

  it("is the desktop app's alone: a browser downloads the file itself", async () => {
    const home = await mkdtemp(join(tmpdir(), "alden-home-"));
    process.env.ALDEN_HOME = home;
    try {
      const api = createUiApi({ version: "0", cwd: home });
      await expect(api.saveBriefing({} as never)).rejects.toThrow("a browser downloads them");
      await expect(api.saveFeedback()).rejects.toThrow("a browser downloads it");
    } finally {
      delete process.env.ALDEN_HOME;
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("seen places through the UI's API", () => {
  it("records them on this machine, once each, and not while learning from reviews is off", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { closeStores, openStore, seenPlaces, setConfigValue } = await import("@alden/core");
    const home = mkdtempSync(join(tmpdir(), "alden-api-"));
    const saved = { home: process.env.ALDEN_HOME, track: process.env.DO_NOT_TRACK };
    process.env.ALDEN_HOME = home;
    process.env.DO_NOT_TRACK = "1";
    try {
      const api = createUiApi({ version: "test", cwd: home });
      const places = [
        { checkId: "callers.outside", path: "src/pay.ts", line: 12, how: "guided" as const },
        { path: "src/web.ts", how: "diff" as const },
      ];
      expect(await api.recordSeen({ pr: "Acme/Shop#412", headSha: "abc1234", places })).toEqual({ recorded: 2 });
      expect(await api.recordSeen({ pr: "acme/shop#412", headSha: "abc1234", places })).toEqual({ recorded: 0 });
      expect(seenPlaces(openStore(), "acme/shop#412", "abc1234")).toEqual(places);

      await setConfigValue("learning.fromReviews", "false");
      const later = [{ path: "src/other.ts", how: "diff" as const }];
      expect(await api.recordSeen({ pr: "acme/shop#413", headSha: "abc1234", places: later })).toEqual({
        recorded: 0,
      });
      expect(seenPlaces(openStore(), "acme/shop#413")).toEqual([]);
      // Never in the feedback export: it reads feedback events, and seen places aren't events.
      expect(JSON.stringify(await api.exportFeedback())).not.toContain("src/pay.ts");
    } finally {
      closeStores();
      process.env.ALDEN_HOME = saved.home;
      if (saved.home === undefined) delete process.env.ALDEN_HOME;
      if (saved.track === undefined) delete process.env.DO_NOT_TRACK;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
