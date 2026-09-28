import { describe, expect, it } from "vitest";
import { parsePrRef } from "./pr-ref.js";

const queue = ["https://github.com/grafana/grafana/pull/133736", "https://github.com/vercel/next.js/pull/99041"];

describe("parsePrRef", () => {
  it.each([
    ["https://github.com/vercel/next.js/pull/99041", "vercel/next.js", 99041],
    ["https://github.com/vercel/next.js/pull/99041/files", "vercel/next.js", 99041],
    ["http://github.com/laravel/framework/pull/60005?diff=split", "laravel/framework", 60005],
    ["django/django#22041", "django/django", 22041],
    ["  gohugoio/hugo#15387  ", "gohugoio/hugo", 15387],
    ["2", "vercel/next.js", 99041],
    ["#1", "grafana/grafana", 133736],
  ])("reads %s", (input, repo, number) => {
    expect(parsePrRef(input, queue)).toEqual({ repo, number });
  });

  it("explains a queue # without a queue, or out of range", () => {
    expect(() => parsePrRef("1", undefined)).toThrow(/Run `alden queue` first/);
    expect(() => parsePrRef("5", queue)).toThrow(/no #5 in your last queue \(it had 2\)/);
  });

  it.each(["vercel/next.js", "https://gitlab.com/a/b/-/merge_requests/1", "next.js#12", "pr 12"])(
    "rejects %s",
    (input) => {
      expect(() => parsePrRef(input, queue)).toThrow(/isn't a PR/);
    },
  );
});
