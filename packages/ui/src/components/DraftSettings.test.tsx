// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftSettings } from "./DraftSettings";

afterEach(cleanup);

describe("DraftSettings", () => {
  it("saves drafts.auto to your user config", async () => {
    const api = { setConfig: vi.fn(async () => ({})) };
    const onSaved = vi.fn();
    render(<DraftSettings api={api} on onSaved={onSaved} />);
    const toggle = screen.getByRole("switch", { name: "Draft comments for me" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Nothing is sent until you keep it and send your review/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.setConfig).toHaveBeenCalledWith("drafts.auto", "false");
  });

  it("puts the switch back and says why when saving fails", async () => {
    const api = { setConfig: vi.fn(async () => Promise.reject(new Error("Couldn't write the config."))) };
    render(<DraftSettings api={api} on={false} onSaved={() => {}} />);
    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("Couldn't write the config.")).toBeTruthy());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
