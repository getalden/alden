import { describe, expect, it } from "vitest";
import { describeGitHubError } from "./github-errors.js";

const httpError = (status: number, message = "Bad credentials") => Object.assign(new Error(message), { status });

describe("describeGitHubError", () => {
  it("explains a rejected token by where it came from", () => {
    expect(describeGitHubError(httpError(401), "alden")).toBe(
      "GitHub rejected Alden's saved GitHub sign-in. It may have been revoked. Run `alden auth login --device` to sign in again, or `alden auth logout` to use your GitHub CLI sign-in instead.",
    );
    expect(describeGitHubError(httpError(401), "gh")).toMatch(
      /^GitHub rejected your GitHub CLI sign-in\. Run `gh auth login`/,
    );
    expect(describeGitHubError(httpError(401), "env")).toContain("Fix or unset ALDEN_GITHUB_TOKEN.");
  });

  it("tells rate limits apart from missing access", () => {
    expect(describeGitHubError(httpError(403, "API rate limit exceeded"), "gh")).toMatch(/rate limit is used up/);
    expect(describeGitHubError(httpError(403, "Resource not accessible"), "gh")).toMatch(/scope/);
  });

  it("keeps other messages as they are", () => {
    expect(describeGitHubError(new Error("Couldn't find a/b#1."), "gh")).toBe("Couldn't find a/b#1.");
  });
});
