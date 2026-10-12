// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../api";
import { initials, TopBar } from "./TopBar";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const session = {
  user: { login: "jrivera", source: "gh" },
  budget: { perReviewUsd: 0.5, dailyUsd: 5, spentToday: 1.84 },
} as unknown as Session;

const api = () => ({
  exportFeedback: vi.fn(async () => [{ kind: "verdict" }, { kind: "verdict" }]),
  saveFeedback: vi.fn(async () => ({ path: "/d/f.json", shown: "~/Downloads/f.json", events: 3 })),
  signOut: vi.fn(async () => ({ remaining: null as string | null })),
});

describe("TopBar", () => {
  it("shows the views without Settings, today's spend, and your initials", () => {
    render(<TopBar session={session} route={{ view: "queue" }} />);
    const nav = screen.getByRole("navigation", { name: "Views" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Queue", "My changes", "Memory", "Stats"]);
    expect(within(nav).getByRole("link", { name: "Queue" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("$1.84 of $5.00 today")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Signed in as @jrivera/ }).textContent).toBe("JR");
    expect(initials("ana")).toBe("AN");
    expect(initials("li-wei")).toBe("LW");
  });

  it("opens Settings, exports feedback and signs out from the avatar's menu", async () => {
    const fake = api();
    const onSignedOut = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    render(<TopBar session={session} route={{ view: "queue" }} api={fake} onSignedOut={onSignedOut} />);
    const avatar = screen.getByRole("button", { name: /Account menu/ });

    fireEvent.click(avatar);
    const menu = screen.getByRole("menu", { name: "Account" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual(["Settings", "Export feedback.json", "Sign out"]);
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Settings" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Export feedback.json");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(avatar);

    fireEvent.click(avatar);
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(window.location.pathname).toBe("/settings");

    fireEvent.click(avatar);
    fireEvent.click(screen.getByRole("menuitem", { name: /Export feedback/ }));
    await screen.findByText("Saved 2 events.");
    expect(fake.exportFeedback).toHaveBeenCalledTimes(1);

    fireEvent.click(avatar);
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status").textContent).toBe("Signed out.");
    vi.unstubAllGlobals();
  });

  it("says what still signs you in, and saves the export to Downloads in the desktop app", async () => {
    const fake = api();
    fake.signOut.mockResolvedValueOnce({ remaining: "Your GitHub CLI sign-in" });
    const { container } = render(
      <TopBar session={{ ...session, desktop: true }} route={{ view: "settings" }} api={fake} />,
    );
    // The bar is the window's title bar: room for its buttons, and it drags the window.
    expect(container.querySelector("header")?.className).toBe("topbar desktop");
    expect(container.querySelector("header")?.hasAttribute("data-tauri-drag-region")).toBe(true);
    const avatar = screen.getByRole("button", { name: /Account menu/ });
    fireEvent.click(avatar);
    fireEvent.click(screen.getByRole("menuitem", { name: /Export feedback/ }));
    await screen.findByText("Saved 3 events to ~/Downloads/f.json.");
    expect(fake.saveFeedback).toHaveBeenCalledTimes(1);
    fireEvent.click(avatar);
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await screen.findByText("Signed out of Alden. Your GitHub CLI sign-in still signs you in.");
  });

  it("shows a problem with the sign-in on the avatar, and has no Sign out without one", () => {
    render(<TopBar session={{ ...session, user: { error: "rejected" } }} route={{ view: "queue" }} api={api()} />);
    const avatar = screen.getByRole("button", { name: /GitHub sign-in problem: rejected/ });
    expect(avatar.textContent).toBe("!");
    fireEvent.click(avatar);
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).toBeNull();
  });
});
