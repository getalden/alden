// @vitest-environment jsdom
import type { FollowUpLevel, PrWatch } from "@alden/schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WatchBell } from "./WatchBell";

afterEach(cleanup);

function fakeApi(start: PrWatch, fail = false) {
  return {
    watch: vi.fn(async () => start),
    setWatch: vi.fn(async (pr: string, level: FollowUpLevel | null): Promise<PrWatch> => {
      if (fail) throw new Error("Couldn't save it.");
      return { pr, ...(level ? { override: level } : {}), level: level ?? "your-turn" };
    }),
  };
}

const select = () => screen.getByRole("combobox", { name: "Notifications about this PR" }) as HTMLSelectElement;

describe("WatchBell", () => {
  it("shows the PR's level, sets its own and goes back to the default", async () => {
    const api = fakeApi({ pr: "acme/shop#12", level: "your-turn" });
    render(<WatchBell api={api} pr="acme/shop#12" />);
    await waitFor(() => expect(select().disabled).toBe(false));
    expect(select().value).toBe("");
    expect([...select().options].map((o) => o.text)).toEqual([
      "Default · Your turn",
      "Off",
      "Re-review only",
      "Your turn",
      "Every reply",
    ]);
    fireEvent.change(select(), { target: { value: "every-reply" } });
    await waitFor(() => expect(api.setWatch).toHaveBeenCalledWith("acme/shop#12", "every-reply"));
    expect(select().value).toBe("every-reply");
    expect(select().className).toContain("on");
    // The default still names the global level while the PR has its own.
    expect(select().options[0]?.text).toBe("Default · Your turn");
    fireEvent.change(select(), { target: { value: "" } });
    await waitFor(() => expect(api.setWatch).toHaveBeenLastCalledWith("acme/shop#12", null));
    expect(select().value).toBe("");
  });

  it("names the global level from Settings, and goes back to what it was when saving fails", async () => {
    const api = fakeApi({ pr: "acme/shop#12", override: "off", level: "off" }, true);
    render(<WatchBell api={api} pr="acme/shop#12" global="rereview" />);
    await waitFor(() => expect(select().value).toBe("off"));
    expect(select().options[0]?.text).toBe("Default · Re-review only");
    fireEvent.change(select(), { target: { value: "your-turn" } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Couldn't save it."));
    expect(select().value).toBe("off");
  });
});
