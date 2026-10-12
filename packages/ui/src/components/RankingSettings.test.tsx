// @vitest-environment jsdom
import { RANK_WEIGHTS, type RankingState, type RankPreview, type RankRule, type RankWeight } from "@alden/schema";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, RankChange } from "../api";
import { describeRule, RankingSettings, WEIGHTS } from "./RankingSettings";

afterEach(cleanup);

const DEFAULTS = Object.fromEntries(WEIGHTS.map((w) => [w.name, 1])) as Record<RankWeight, number>;

function state(
  overrides: { rules?: RankRule[]; weights?: Partial<Record<RankWeight, number>>; prepare?: number } = {},
) {
  return {
    path: "/home/sam/.alden/config.toml",
    settings: { ...DEFAULTS, ...overrides.weights, rules: overrides.rules ?? [] },
    prepare: overrides.prepare ?? 3,
    background: true,
  } satisfies RankingState;
}

const row = (n: number, was: number | null, reasons: string[] = []): RankPreview["top"][number] => ({
  pr: `acme/shop#${n}`,
  title: `PR ${n}`,
  url: `https://github.com/acme/shop/pull/${n}`,
  author: "sam",
  total: 10 - n,
  was,
  reasons,
  breakdown: [],
});

const preview = (top: RankPreview["top"], extra: Partial<RankPreview> = {}): RankPreview => ({
  fetchedAt: "2026-10-06T10:00:00Z",
  needsYou: 8,
  top,
  ...extra,
});

function fakeApi(
  initial = state(),
  result: RankPreview = preview([row(1, 1), row(2, 4, ["↑ your rule: payments/ first"])]),
) {
  return {
    rank: vi.fn(async () => initial),
    saveRank: vi.fn(async (change: RankChange) =>
      state({
        rules: change.rules ?? [],
        weights: Object.fromEntries(Object.entries(change.weights ?? {}).map(([k, v]) => [k, v ?? 1])),
        prepare: change.prepare ?? 3,
      }),
    ),
    previewRank: vi.fn(async () => result),
  };
}

const show = (api: ReturnType<typeof fakeApi>, desktop = true, onSaved = vi.fn()) => {
  render(<RankingSettings api={api as unknown as Api} desktop={desktop} onSaved={onSaved} />);
  return onSaved;
};

const slider = (label: string) => screen.getByLabelText(new RegExp(`^${label}`)) as HTMLInputElement;

describe("RankingSettings", () => {
  it("shows every weight at its saved value, and a live top 5 from the current queue", async () => {
    show(fakeApi(state({ weights: { waiting: 2, size: 0 } })));
    await screen.findByText("Weights");
    expect(slider("Waiting time").value).toBe("2");
    expect(screen.getAllByText("×2")).toHaveLength(1);
    expect(screen.getByText("off")).toBeTruthy();
    expect(screen.getAllByText("×1")).toHaveLength(WEIGHTS.length - 2);
    await screen.findByText("PR 2");
    expect(screen.getByText("up from 4")).toBeTruthy();
    expect(screen.getByText("↑ your rule: payments/ first").className).toBe("chip rule");
    expect(screen.getByText(/Of 8 in Needs you/)).toBeTruthy();
    // The background keeps the top three briefed: both shown rows are in it.
    expect(screen.getAllByText(/· briefed in the background/)).toHaveLength(2);
  });

  it("has a slider for every weight the ranking takes, re-reviews included", async () => {
    expect(WEIGHTS.map((w) => w.name).sort()).toEqual([...RANK_WEIGHTS].sort());
    show(fakeApi(state({ weights: { rereview: 0 } })));
    await screen.findByText("Weights");
    expect(slider("Re-reviews").value).toBe("0");
  });

  it("re-ranks the preview as a weight moves, before anything is saved, and resets to the defaults", async () => {
    const api = fakeApi();
    show(api);
    await screen.findByText("PR 1");
    fireEvent.change(slider("Urgent labels"), { target: { value: "0" } });
    await waitFor(() =>
      expect(api.previewRank).toHaveBeenLastCalledWith({ weights: { ...DEFAULTS, urgentLabel: 0 }, rules: [] }),
    );
    expect(api.saveRank).not.toHaveBeenCalled();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(slider("Urgent labels").value).toBe("1");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("adds a rule with the form, refuses one with no condition, and saves it with the weights that changed", async () => {
    const api = fakeApi();
    const onSaved = show(api);
    await screen.findByText(/None yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
    const form = screen.getByRole("group", { name: "New rule" });
    fireEvent.click(within(form).getByRole("button", { name: "Add rule" }));
    expect(within(form).getByRole("alert").textContent).toBe("Give the rule at least one condition.");

    fireEvent.change(within(form).getByLabelText("Touches path"), { target: { value: " payments/ " } });
    fireEvent.click(within(form).getByRole("button", { name: "Add rule" }));
    expect(screen.getByText("↑ payments/ first")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
    const second = screen.getByRole("group", { name: "New rule" });
    fireEvent.change(within(second).getByLabelText("Author"), { target: { value: "bots" } });
    fireEvent.change(within(second).getByLabelText(/^Then/), { target: { value: "lower" } });
    fireEvent.change(within(second).getByLabelText("Points"), { target: { value: "3" } });
    fireEvent.click(within(second).getByRole("button", { name: "Add rule" }));
    expect(screen.getByText("↓ bots −3")).toBeTruthy();

    fireEvent.change(slider("Waiting time"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ranking" }));
    await waitFor(() => expect(api.saveRank).toHaveBeenCalled());
    const change = api.saveRank.mock.calls[0]?.[0] as RankChange;
    expect(change.rules).toEqual([
      { when: { path: "payments/" }, then: "first" },
      { when: { author: "bots" }, then: "lower", by: 3 },
    ]);
    expect(change.weights?.waiting).toBe(1.5);
    expect(change.weights?.size).toBeNull();
    expect(change.prepare).toBeNull();
    const asked = api.previewRank.mock.calls.length;
    await screen.findByText(/Saved. The queue uses it/);
    expect(onSaved).toHaveBeenCalled();
    // The preview compares against the saved settings, so it asks again once they change.
    await waitFor(() => expect(api.previewRank.mock.calls.length).toBeGreaterThan(asked));
  });

  it("reorders, edits and deletes rules", async () => {
    const rules: RankRule[] = [
      { when: { path: "payments/" }, then: "first" },
      { when: { author: "bots" }, then: "last" },
    ];
    show(fakeApi(state({ rules })));
    await screen.findByText("↑ payments/ first");
    const order = () => [...document.querySelectorAll(".rank-rule-text")].map((el) => el.textContent);
    fireEvent.click(screen.getByRole("button", { name: "Move rule 2 up" }));
    expect(order()).toEqual(["↓ bots last", "↑ payments/ first"]);
    expect((screen.getByRole("button", { name: "Move rule 1 up" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1] as HTMLElement);
    const form = screen.getByRole("group", { name: "Edit rule" });
    expect((within(form).getByLabelText("Touches path") as HTMLInputElement).value).toBe("payments/");
    fireEvent.change(within(form).getByLabelText("Name on the row (optional)"), { target: { value: "payments" } });
    fireEvent.click(within(form).getByRole("button", { name: "Done" }));
    expect(order()).toEqual(["↓ bots last", "↑ payments first"]);

    fireEvent.click(screen.getByRole("button", { name: "Delete rule 1" }));
    expect(order()).toEqual(["↑ payments first"]);
  });

  it("keeps the top N briefed in the desktop app only, 0 to 10", async () => {
    const api = fakeApi(state({ prepare: 3 }));
    show(api);
    const input = (await screen.findByLabelText(/Keep the top PRs briefed/)) as HTMLInputElement;
    expect(input.value).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(input.value).toBe("5");
    fireEvent.change(input, { target: { value: "40" } });
    expect(input.value).toBe("10");
    fireEvent.change(input, { target: { value: "0" } });
    expect(screen.getByText(/won't brief PRs while you're away/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save ranking" }));
    await waitFor(() => expect(api.saveRank.mock.calls[0]?.[0]).toMatchObject({ prepare: 0 }));
    cleanup();

    const web = fakeApi();
    show(web, false);
    await screen.findByText("Weights");
    expect(screen.queryByLabelText(/Keep the top PRs briefed/)).toBeNull();
    expect(screen.queryByText(/· briefed in the background/)).toBeNull();
  });

  it("says why there's no preview, or that nothing is waiting", async () => {
    show(fakeApi(state(), preview([], { fetchedAt: null, needsYou: 0, problem: "Not signed in to GitHub." })));
    await screen.findByText("No preview: Not signed in to GitHub.");
    cleanup();
    show(fakeApi(state(), preview([], { needsYou: 0 })));
    await screen.findByText(/Nothing is waiting on you/);
  });

  it("says when the settings can't be loaded, and when a save is refused", async () => {
    show({ ...fakeApi(), rank: vi.fn(async () => Promise.reject(new Error("The request failed (500)."))) });
    await screen.findByText(/Couldn't load your ranking settings: The request failed/);
    cleanup();

    const api = fakeApi();
    api.saveRank.mockRejectedValueOnce(new Error("Invalid ranking setting (queue.rank.waiting): Too big"));
    show(api);
    await screen.findByText("Weights");
    fireEvent.change(slider("Waiting time"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ranking" }));
    await screen.findByText(/Invalid ranking setting/);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });
});

describe("describeRule", () => {
  it("says a rule the way the queue's reasons do", () => {
    expect(describeRule({ when: { label: "security", base: "main" }, then: "boost" })).toBe(
      "↑ labelled security and into main +5",
    );
    expect(describeRule({ when: { author: "@lee" }, then: "lower", by: 2 })).toBe("↓ @lee −2");
    expect(describeRule({ when: { author: "agents" }, then: "last" })).toBe("↓ AI agents last");
  });
});
