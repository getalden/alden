// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderNotice } from "./App";

afterEach(cleanup);

describe("FolderNotice", () => {
  it("says where callers come from now, and shows every repo again", () => {
    const onShowAll = vi.fn();
    render(
      <FolderNotice note={{ root: "/Users/sam/src/sandbox", repo: "acme/sandbox" }} filtered onShowAll={onShowAll} />,
    );
    expect(screen.getByRole("status").textContent).toMatch(
      /Callers now come from \/Users\/sam\/src\/sandbox\. Showing acme\/sandbox only\./,
    );
    fireEvent.click(screen.getByText("Show all repos"));
    expect(onShowAll).toHaveBeenCalled();
  });

  it("says so when the folder isn't a clone", () => {
    render(<FolderNotice note={{ root: "/tmp/x", repo: undefined }} filtered={false} onShowAll={() => {}} />);
    expect(screen.getByRole("status").textContent).toMatch(/isn't a clone of a GitHub repo/);
  });
});
