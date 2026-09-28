import { describe, expect, it } from "vitest";
import { isOwner, ownersOf, parseCodeowners } from "./codeowners.js";

const FILE = `
# Everything defaults to the platform team
*                 @acme/platform

/docs/            @writer         # docs have their own owner
*.go              @gopher @acme/backend
/payments/        @acme/payments
/payments/README.md
`;

describe("CODEOWNERS", () => {
  const rules = parseCodeowners(FILE);

  it("skips comments and blank lines", () => {
    expect(rules.map((r) => r.pattern)).toEqual(["*", "/docs/", "*.go", "/payments/", "/payments/README.md"]);
  });

  it("lets the last matching rule win", () => {
    expect(ownersOf(rules, "src/app.ts")).toEqual(["@acme/platform"]);
    expect(ownersOf(rules, "docs/intro.md")).toEqual(["@writer"]);
    expect(ownersOf(rules, "cmd/server/main.go")).toEqual(["@gopher", "@acme/backend"]);
    expect(ownersOf(rules, "payments/stripe.ts")).toEqual(["@acme/payments"]);
  });

  it("treats a rule with no owners as clearing ownership", () => {
    expect(ownersOf(rules, "payments/README.md")).toEqual([]);
  });

  it("anchors leading-slash patterns to the repo root", () => {
    expect(ownersOf(rules, "src/docs/notes.md")).toEqual(["@acme/platform"]);
  });

  it("recognises the viewer directly or through a team, ignoring case", () => {
    const teams = new Set(["acme/backend"]);
    expect(isOwner(["@Gopher"], "gopher", teams)).toBe(true);
    expect(isOwner(["@ACME/Backend"], "someone", teams)).toBe(true);
    expect(isOwner(["@acme/payments", "ops@acme.com"], "someone", teams)).toBe(false);
  });
});
