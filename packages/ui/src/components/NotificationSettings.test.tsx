// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationSettings } from "./NotificationSettings";

afterEach(cleanup);

describe("NotificationSettings", () => {
  it("saves the sound setting to your user config", async () => {
    const api = { setConfig: vi.fn(async () => ({})) };
    const onSaved = vi.fn();
    render(<NotificationSettings api={api} sound onSaved={onSaved} />);
    const toggle = screen.getByRole("switch", { name: "Play a sound when a briefing is ready" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.setConfig).toHaveBeenCalledWith("notifications.sound", "false");
  });

  it("saves how much you hear about PRs you reviewed, your turn unless you chose", async () => {
    const api = { setConfig: vi.fn(async () => ({})) };
    const onSaved = vi.fn();
    render(<NotificationSettings api={api} sound onSaved={onSaved} />);
    const group = screen.getByRole("group", { name: "Follow-ups on PRs you reviewed" });
    expect(screen.getByRole("button", { name: "When it's your turn" }).getAttribute("aria-pressed")).toBe("true");
    expect(group.textContent).toBe("OffRe-review onlyWhen it's your turnEvery reply");
    fireEvent.click(screen.getByRole("button", { name: "Every reply" }));
    expect(screen.getByRole("button", { name: "Every reply" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Each reply, resolve and re-review/)).toBeTruthy();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.setConfig).toHaveBeenCalledWith("notifications.followUps", "every-reply");
  });

  it("goes back to the level you had when saving it fails", async () => {
    const api = { setConfig: vi.fn(async () => Promise.reject(new Error("Couldn't write the config."))) };
    render(<NotificationSettings api={api} sound followUps="rereview" onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Off" }));
    await waitFor(() => expect(screen.getByText("Couldn't write the config.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Re-review only" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("puts the switch back and says why when saving fails", async () => {
    const api = { setConfig: vi.fn(async () => Promise.reject(new Error("Couldn't write the config."))) };
    render(<NotificationSettings api={api} sound={false} onSaved={() => {}} />);
    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("Couldn't write the config.")).toBeTruthy());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
