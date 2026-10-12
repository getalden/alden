// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, Session } from "../api";
import { SettingsView } from "./SettingsView";

afterEach(cleanup);

const KEY = `sk-ant-api03-${"a".repeat(40)}`;

const session = (key: Session["model"]["key"]) =>
  ({
    version: "0",
    cwd: "/",
    repo: null,
    user: { login: "sam", source: "alden" },
    model: {
      provider: "anthropic",
      name: "sonnet",
      id: "claude-sonnet-5",
      effort: null,
      supportsEffort: true,
      available: !!key,
      key,
    },
    aliases: { sonnet: "claude-sonnet-5" },
    efforts: ["low", "high"],
    budget: { perReviewUsd: 0.5, dailyUsd: 10, spentToday: 0 },
  }) as Session;

function fakeApi() {
  const keys: {
    anthropic: { source: "alden"; where: string } | null;
    openai: { source: "env"; where: string } | null;
  } = {
    anthropic: null,
    openai: { source: "env", where: "OPENAI_API_KEY" },
  };
  return {
    modelSetup: vi.fn(async () => ({ key: keys.anthropic, openaiKey: keys.openai })),
    spend: vi.fn(async () => ({ spentToday: 0, dailyUsd: 10, perReviewUsd: 0.5, byModel: [], lastDays: [] })),
    feedbackSummary: vi.fn(async () => ({ briefings: 0 })),
    telemetry: vi.fn(async () => ({ consent: "off", blocked: null })),
    rank: vi.fn(async () => ({ path: "/c.toml", settings: { rules: [] }, prepare: 3, background: false })),
    previewRank: vi.fn(async () => ({ fetchedAt: null, needsYou: 0, top: [] })),
    setModelKey: vi.fn(async (key: string | null) => {
      keys.anthropic = key ? { source: "alden", where: "the key you stored with `alden auth model`" } : null;
      return { provider: "anthropic", key: keys.anthropic };
    }),
  };
}

describe("SettingsView", () => {
  it("stores either kind of key write-only, then clears the field and says where each key comes from", async () => {
    const api = fakeApi();
    const onSaved = vi.fn();
    render(<SettingsView api={api as unknown as Api} session={session(null)} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText("from OPENAI_API_KEY")).toBeTruthy());
    expect(screen.getByText("none (or set ANTHROPIC_API_KEY)")).toBeTruthy();
    const input = screen.getByPlaceholderText("sk-ant-… or sk-…") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: KEY } });
    expect(screen.getByRole("status", { name: "Anthropic key" })).toBeTruthy();
    fireEvent.click(screen.getByText("Store key"));
    await waitFor(() => expect(api.setModelKey).toHaveBeenCalledWith(KEY, undefined));
    await waitFor(() => expect(input.value).toBe(""));
    await waitFor(() => expect(screen.getByText("from the key you stored with `alden auth model`")).toBeTruthy());
    expect(screen.getByText("Stored your Anthropic key in your keychain.")).toBeTruthy();
    expect(onSaved).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Remove"));
    await waitFor(() => expect(api.setModelKey).toHaveBeenLastCalledWith(null, "anthropic"));
  });

  it("offers to run setup again", () => {
    const onRunSetup = vi.fn();
    render(
      <SettingsView
        api={fakeApi() as unknown as Api}
        session={session(null)}
        onSaved={() => {}}
        onRunSetup={onRunSetup}
      />,
    );
    fireEvent.click(screen.getByText("Run setup again"));
    expect(onRunSetup).toHaveBeenCalled();
  });

  it("lays its toggles out in groups, not fieldsets, so the buttons fill their box", () => {
    const { container } = render(
      <SettingsView api={fakeApi() as unknown as Api} session={session(null)} onSaved={() => {}} />,
    );
    expect(container.querySelector("fieldset")).toBeNull();
    expect(screen.getByRole("group", { name: "Default effort" }).className).toBe("segmented");
    expect(screen.getByRole("group", { name: "Theme" })).toBeTruthy();
  });
});
