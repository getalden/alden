// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearningSettings } from "./LearningSettings";

afterEach(cleanup);

describe("LearningSettings", () => {
  it("saves learning.fromReviews to your user config", async () => {
    const api = { setConfig: vi.fn(async () => ({})) };
    const onSaved = vi.fn();
    render(<LearningSettings api={api} on onSaved={onSaved} />);
    const toggle = screen.getByRole("switch", { name: "Learn from my reviews" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.setConfig).toHaveBeenCalledWith("learning.fromReviews", "false");
    fireEvent.click(toggle);
    await waitFor(() => expect(api.setConfig).toHaveBeenLastCalledWith("learning.fromReviews", "true"));
  });

  it("puts the switch back and says why when saving fails", async () => {
    const api = { setConfig: vi.fn(async () => Promise.reject(new Error("Couldn't write the config."))) };
    render(<LearningSettings api={api} on={false} onSaved={() => {}} />);
    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("Couldn't write the config.")).toBeTruthy());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
