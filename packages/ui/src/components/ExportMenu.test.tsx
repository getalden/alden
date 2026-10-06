// @vitest-environment jsdom
import type { Briefing } from "@alden/schema";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportMenu } from "./ExportMenu";

const briefing = { target: { kind: "pr", repo: "a/b", number: 1 }, files: [] } as unknown as Briefing;

function fakeApi() {
  return {
    briefingMarkdown: vi.fn(async () => ({ markdown: "# Fix it\n", fileName: "a-b-1-briefing.md" })),
    saveBriefing: vi.fn(async () => ({
      path: "/Users/sam/Downloads/a-b-1-briefing.md",
      shown: "~/Downloads/a-b-1-briefing.md",
    })),
  };
}

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const press = (key: string, target: Element | Window = window) => fireEvent.keyDown(target, { key });

describe("ExportMenu", () => {
  it("opens with e, starts on the first item, and closes with Esc", async () => {
    const api = fakeApi();
    render(<ExportMenu briefing={briefing} api={api} desktop={false} />);
    expect(screen.queryByRole("menu")).toBeNull();
    press("e");
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "Copy as Markdown",
      "Save as Markdown.md file",
      "Print / Save as PDF",
    ]);
    expect(document.activeElement).toBe(items[0]);
    expect(api.briefingMarkdown).toHaveBeenCalledWith(briefing);
    press("ArrowDown", items[0] as HTMLElement);
    expect(document.activeElement).toBe(items[1]);
    press("ArrowUp", items[1] as HTMLElement);
    press("ArrowUp", items[0] as HTMLElement);
    expect(document.activeElement).toBe(items[2]);
    press("Escape", items[2] as HTMLElement);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Export/ }));
  });

  it("doesn't open while you type", () => {
    render(
      <>
        <input aria-label="note" />
        <ExportMenu briefing={briefing} api={fakeApi()} desktop={false} />
      </>,
    );
    press("e", screen.getByLabelText("note"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the page's own keys out of the menu", () => {
    const onKey = vi.fn();
    window.addEventListener("keydown", onKey);
    render(<ExportMenu briefing={briefing} api={fakeApi()} desktop={false} />);
    press("e");
    onKey.mockClear();
    press("c", screen.getAllByRole("menuitem")[0] as HTMLElement);
    expect(onKey).not.toHaveBeenCalled();
    window.removeEventListener("keydown", onKey);
  });

  it("copies the Markdown and says so", async () => {
    render(<ExportMenu briefing={briefing} api={fakeApi()} desktop={false} />);
    press("e");
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as Markdown" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Copied as Markdown."));
    expect(writeText).toHaveBeenCalledWith("# Fix it\n");
  });

  it("says why when it couldn't copy", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<ExportMenu briefing={briefing} api={fakeApi()} desktop={false} />);
    press("e");
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as Markdown" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Couldn't copy it: /));
  });

  it("downloads a .md file named after the PR in a browser", async () => {
    const create = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("a-b-1-briefing.md");
    });
    const api = fakeApi();
    render(<ExportMenu briefing={briefing} api={api} desktop={false} />);
    press("e");
    fireEvent.click(screen.getByRole("menuitem", { name: /Save as Markdown/ }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Downloaded a-b-1-briefing.md."));
    expect(click).toHaveBeenCalled();
    expect(api.saveBriefing).not.toHaveBeenCalled();
  });

  it("saves to Downloads through the server in the desktop app, and says where", async () => {
    const api = fakeApi();
    render(<ExportMenu briefing={briefing} api={api} desktop />);
    press("e");
    fireEvent.click(screen.getByRole("menuitem", { name: /Save as Markdown/ }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved to ~/Downloads/a-b-1-briefing.md."));
    expect(api.saveBriefing).toHaveBeenCalledWith(briefing);
  });

  it("prints, and says so when the desktop app's window can't", async () => {
    const print = vi.fn();
    window.print = print;
    render(<ExportMenu briefing={briefing} api={fakeApi()} desktop={false} />);
    press("e");
    fireEvent.click(screen.getByRole("menuitem", { name: "Print / Save as PDF" }));
    expect(print).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();

    window.print = vi.fn(() => Promise.reject(new Error("not allowed"))) as unknown as typeof window.print;
    press("e");
    fireEvent.click(screen.getByRole("menuitem", { name: "Print / Save as PDF" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Couldn't print: not allowed"));
  });
});
