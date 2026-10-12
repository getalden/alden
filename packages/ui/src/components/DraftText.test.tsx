// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DraftText } from "./DraftText";

afterEach(cleanup);

const LONG =
  "The title says options should be required, but this adds `options=None` as optional and it's never used in the function body. Either make it required and implement its behavior, or update the title/description to reflect what this actually does.";

describe("a draft's text in a list", () => {
  it("shows a long one cut, with Show all and Show less to read it where it is", () => {
    render(<DraftText text={LONG} />);
    const text = screen.getByText(LONG);
    expect(text.className).toBe("draft-body excerpt");
    const more = screen.getByRole("button", { name: "Show all" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.getAttribute("aria-controls")).toBe(text.id);
    // A button: Enter and Space work as they do on any other.
    more.focus();
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    expect(text.className).toBe("draft-body excerpt open");
    const less = screen.getByRole("button", { name: "Show less" });
    expect(less.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(less);
    expect(text.className).toBe("draft-body excerpt");
  });

  it("offers nothing more for a short one", () => {
    render(<DraftText text="Cents?" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("measures the text when it's laid out", () => {
    const sizes = (scroll: number, client: number) => {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scroll });
      Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => client });
    };
    try {
      sizes(84, 84);
      render(<DraftText text={LONG} />);
      expect(screen.queryByRole("button")).toBeNull();
      cleanup();
      sizes(140, 84);
      render(<DraftText text={"One line\nthat wraps"} />);
      expect(screen.getByRole("button", { name: "Show all" })).toBeTruthy();
    } finally {
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
  });
});
