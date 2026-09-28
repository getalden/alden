import { DEFAULT_SENSITIVE_PATHS } from "@alden/schema";
import { describe, expect, it } from "vitest";
import { fileKind, isPatchBumpTitle, sensitiveMatcher } from "./files.js";

describe("fileKind", () => {
  it.each([
    ["README.md", "docs"],
    ["docs/guide/install.mdx", "docs"],
    ["CHANGELOG.md", "docs"],
    ["src/app.test.ts", "test"],
    ["src/__tests__/app.ts", "test"],
    ["tests/Feature/UserTest.php", "test"],
    ["src/Illuminate/Support/StrTest.php", "test"],
    ["pkg/server/handler_test.go", "test"],
    ["tests/test_models.py", "test"],
    ["django/db/models/test_utils.py", "test"],
    ["package.json", "dependency"],
    ["web/pnpm-lock.yaml", "dependency"],
    ["composer.lock", "dependency"],
    ["go.sum", "dependency"],
    ["requirements-dev.txt", "dependency"],
    ["src/Illuminate/Support/Str.php", "code"],
    ["hugolib/site.go", "code"],
    ["packages/next/src/server/render.tsx", "code"],
    ["django/db/models/query.py", "code"],
    ["public/logo.svg", "other"],
    [".github/workflows/ci.yml", "other"],
  ])("%s is %s", (path, kind) => {
    expect(fileKind(path)).toBe(kind);
  });
});

describe("sensitive paths", () => {
  const matches = sensitiveMatcher(DEFAULT_SENSITIVE_PATHS);

  it("matches the defaults at any depth", () => {
    expect(matches("database/migrations/2026_09_28_create_users.php")).toBe(true);
    expect(matches("app/auth/session.ts")).toBe(true);
    expect(matches(".github/workflows/release.yml")).toBe(true);
    expect(matches("pnpm-lock.yaml")).toBe(true);
    expect(matches("src/app.ts")).toBe(false);
  });

  it("matches nothing when the user clears the list", () => {
    expect(sensitiveMatcher([])("migrations/001.sql")).toBe(false);
  });
});

describe("isPatchBumpTitle", () => {
  it("accepts patch bumps and rejects minor or major ones", () => {
    expect(isPatchBumpTitle("Bump lodash from 4.17.20 to 4.17.21")).toBe(true);
    expect(isPatchBumpTitle("chore(deps): bump golang.org/x/net from v0.33.0 to v0.33.1")).toBe(true);
    expect(isPatchBumpTitle("Bump react from 19.0.0 to 19.1.0")).toBe(false);
    expect(isPatchBumpTitle("Bump django from 5.2.4 to 6.0.0")).toBe(false);
    expect(isPatchBumpTitle("Fix queue ranking")).toBe(false);
  });
});
