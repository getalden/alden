import { describe, expect, it } from "vitest";
import { majorBumps } from "./bumps.js";

const json = (value: unknown) => JSON.stringify(value);

describe("majorBumps", () => {
  it("finds a composer major bump, like carbon 3 → 4", () => {
    const before = json({ require: { php: "^8.2", "nesbot/carbon": "^3.8", "laravel/framework": "^12.0" } });
    const after = json({ require: { php: "^8.2", "nesbot/carbon": "^4.0", "laravel/framework": "^12.1" } });
    expect(majorBumps("composer.json", before, after)).toEqual([{ name: "nesbot/carbon", from: "3", to: "4" }]);
  });

  it("treats a 0.x minor bump as breaking, and ignores minor and patch bumps", () => {
    const before = json({
      dependencies: { tokenizer: "^0.2.1", react: "^19.0.0" },
      devDependencies: { vitest: "~5.0.0" },
    });
    const after = json({
      dependencies: { tokenizer: "^0.3.0", react: "^19.2.0" },
      devDependencies: { vitest: "~5.1.0" },
    });
    expect(majorBumps("web/package.json", before, after)).toEqual([{ name: "tokenizer", from: "0.2", to: "0.3" }]);
  });

  it("only counts upgrades: a branch behind its base looks like a downgrade", () => {
    expect(
      majorBumps("package.json", json({ dependencies: { a: "^4" } }), json({ dependencies: { a: "^3" } })),
    ).toEqual([]);
  });

  it("follows Go modules whose major version is in the path", () => {
    const before = "module x\nrequire (\n\tgithub.com/redis/go-redis/v8 v8.11.5\n\tgopkg.in/yaml.v2 v2.4.0\n)\n";
    const after = "module x\nrequire (\n\tgithub.com/redis/go-redis/v9 v9.7.0\n\tgopkg.in/yaml.v3 v3.0.1\n)\n";
    expect(majorBumps("go.mod", before, after)).toEqual([
      { name: "github.com/redis/go-redis", from: "8", to: "9" },
      { name: "gopkg.in/yaml", from: "2", to: "3" },
    ]);
  });

  it("reads Python and Rust manifests", () => {
    expect(majorBumps("requirements.txt", "Django==4.2.1\n", "Django==5.0\n")).toEqual([
      { name: "django", from: "4", to: "5" },
    ]);
    const cargo = (v: string) => `[dependencies]\nserde = "1.0"\ntokio = { version = "${v}", features = ["full"] }\n`;
    expect(majorBumps("Cargo.toml", cargo("0.38"), cargo("1.40"))).toEqual([{ name: "tokio", from: "0.38", to: "1" }]);
  });

  it("says nothing for added or removed manifests, other files, or content that doesn't parse", () => {
    expect(majorBumps("package.json", undefined, json({ dependencies: { a: "^2" } }))).toEqual([]);
    expect(majorBumps("src/app.ts", "a", "b")).toEqual([]);
    expect(majorBumps("package.json", "{", json({}))).toEqual([]);
  });
});
