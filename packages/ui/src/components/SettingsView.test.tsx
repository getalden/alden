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
  return {
    spend: vi.fn(async () => ({ spentToday: 0, dailyUsd: 10, perReviewUsd: 0.5, byModel: [], lastDays: [] })),
    feedbackSummary: vi.fn(async () => ({ briefings: 0 })),
    telemetry: vi.fn(async () => ({ consent: "off", blocked: null })),
    setModelKey: vi.fn(async (key: string | null) => ({
      key: key ? { source: "alden", where: "the key you stored with `alden auth model`" } : null,
    })),
  };
}

describe("SettingsView", () => {
  it("stores the model key write-only, then clears the field and says where the key comes from", async () => {
    const api = fakeApi();
    const onSaved = vi.fn();
    render(<SettingsView api={api as unknown as Api} session={session(null)} onSaved={onSaved} />);
    expect(screen.getByText(/None yet/)).toBeTruthy();
    const input = screen.getByPlaceholderText("sk-ant-api03-…") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.click(screen.getByText("Store key"));
    await waitFor(() => expect(api.setModelKey).toHaveBeenCalledWith(KEY));
    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.getByText(/Alden uses the key you stored/)).toBeTruthy();
    expect(onSaved).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Remove stored key"));
    await waitFor(() => expect(api.setModelKey).toHaveBeenLastCalledWith(null));
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
