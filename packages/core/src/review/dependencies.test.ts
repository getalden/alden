import { describe, expect, it } from "vitest";
import { diffDependencies, isMajorChange, isManifest, parseManifest } from "./dependencies.js";

const names = (path: string, text: string) =>
  [...parseManifest(path, text).values()].map((d) => `${d.group}:${d.name}@${d.version}`).sort();

describe("parseManifest", () => {
  it("reads package.json groups and ignores scripts", () => {
    const text = JSON.stringify({
      name: "app",
      scripts: { build: "tsup" },
      dependencies: { react: "^19.0.0" },
      devDependencies: { vitest: "^5.0.0" },
      peerDependencies: { "react-dom": ">=18" },
      optionalDependencies: { fsevents: "^2.3.3" },
    });
    expect(names("web/package.json", text)).toEqual([
      "dev:vitest@^5.0.0",
      "optional:fsevents@^2.3.3",
      "peer:react-dom@>=18",
      "runtime:react@^19.0.0",
    ]);
  });

  it("reads yarn resolutions, npm overrides (nested too) and pnpm.overrides as overrides", () => {
    const text = JSON.stringify({
      dependencies: { react: "^19.0.0" },
      resolutions: { "**/minimist": "1.2.8" },
      overrides: { semver: "7.6.3", "@babel/core": { ".": "7.26.0", json5: "2.2.3" } },
      pnpm: { overrides: { "lodash@<4.17.21": "4.17.21" } },
    });
    expect(names("package.json", text)).toEqual([
      "override:**/minimist@1.2.8",
      "override:@babel/core > json5@2.2.3",
      "override:@babel/core@7.26.0",
      "override:lodash@<4.17.21@4.17.21",
      "override:semver@7.6.3",
      "runtime:react@^19.0.0",
    ]);
  });

  it("reads composer.json, skipping php and extensions", () => {
    const text = JSON.stringify({
      require: { php: "^8.3", "ext-json": "*", "laravel/framework": "^13.0" },
      "require-dev": { "phpunit/phpunit": "^12.0" },
    });
    expect(names("composer.json", text)).toEqual(["dev:phpunit/phpunit@^12.0", "runtime:laravel/framework@^13.0"]);
  });

  it("reads go.mod blocks, single requires and indirect markers", () => {
    const text = [
      "module example.com/app",
      "go 1.25",
      "require github.com/spf13/cobra v1.9.1",
      "require (",
      "\tgolang.org/x/net v0.33.0",
      "\tgithub.com/davecgh/go-spew v1.1.1 // indirect",
      ")",
    ].join("\n");
    expect(names("go.mod", text)).toEqual([
      "optional:github.com/davecgh/go-spew@v1.1.1",
      "runtime:github.com/spf13/cobra@v1.9.1",
      "runtime:golang.org/x/net@v0.33.0",
    ]);
  });

  it("reads Cargo.toml tables, workspace versions and target tables, skipping path-only crates", () => {
    const text = `
[dependencies]
serde = "1.0"
tokio = { version = "1.40", features = ["full"] }
local = { path = "../local" }
shared = { workspace = true }

[dev-dependencies]
insta = "1.41"

[workspace.dependencies]
anyhow = "1"

[target.'cfg(unix)'.dependencies]
nix = "0.29"
`;
    expect(names("Cargo.toml", text)).toEqual([
      "dev:insta@1.41",
      "runtime:anyhow@1",
      "runtime:nix@0.29",
      "runtime:serde@1.0",
      "runtime:tokio@1.40",
    ]);
    expect(isManifest("crates/core/Cargo.toml")).toBe(true);
  });

  it("reads requirements files, treating -dev files as dev", () => {
    const text =
      "# pinned\nDjango==5.2.4\ncelery[redis]>=5.4 ; python_version >= '3.11'\n-r base.txt\n--index-url https://x\n";
    expect(names("requirements.txt", text)).toEqual(["runtime:celery@>=5.4", "runtime:django@==5.2.4"]);
    expect(names("requirements-dev.txt", "pytest==8.4\n")).toEqual(["dev:pytest@==8.4"]);
  });

  it("reads pyproject.toml: PEP 621, optional, dependency groups and Poetry", () => {
    const pep621 = `
[project]
dependencies = ["httpx>=0.28", "pydantic==2.11.0"]
[project.optional-dependencies]
postgres = ["psycopg[binary]>=3.2"]
[dependency-groups]
dev = ["pytest>=8", { include-group = "lint" }]
`;
    expect(names("pyproject.toml", pep621)).toEqual([
      "dev:pytest@>=8",
      "optional:psycopg@>=3.2",
      "runtime:httpx@>=0.28",
      "runtime:pydantic@==2.11.0",
    ]);
    const poetry = `
[tool.poetry.dependencies]
python = "^3.12"
Django = "^5.2"
requests = { version = "^2.32", extras = ["socks"] }
[tool.poetry.group.dev.dependencies]
ruff = "^0.12"
`;
    expect(names("pyproject.toml", poetry)).toEqual([
      "dev:ruff@^0.12",
      "runtime:django@^5.2",
      "runtime:requests@^2.32",
    ]);
  });

  it("throws on content it can't parse, so the check can say so", () => {
    expect(() => parseManifest("package.json", "{ not json")).toThrow();
  });
});

describe("isManifest", () => {
  it("recognises manifests at any depth, not lockfiles", () => {
    expect(
      [
        "package.json",
        "apps/web/package.json",
        "composer.json",
        "go.mod",
        "requirements-dev.txt",
        "pyproject.toml",
      ].every((p) => isManifest(p)),
    ).toBe(true);
    expect(["package-lock.json", "go.sum", "composer.lock", "src/package.ts"].some((p) => isManifest(p))).toBe(false);
  });
});

describe("isMajorChange", () => {
  it.each([
    ["^18.2.0", "^19.0.0", true],
    ["^19.0.0", "^19.1.0", false],
    ["0.33.0", "0.34.0", true],
    ["0.33.0", "0.33.1", false],
    ["v1.9.1", "v2.0.0", true],
    ["==5.2.4", ">=6.0", true],
    ["16.4.0-canary.39", "workspace:*", false],
  ])("%s → %s is major: %s", (from, to, major) => {
    expect(isMajorChange(from, to)).toBe(major);
  });
});

describe("diffDependencies", () => {
  it("lists added, removed, updated and major changes", () => {
    const before = JSON.stringify({ dependencies: { react: "^18.2.0", lodash: "^4.17.20", moment: "^2.30.0" } });
    const after = JSON.stringify({ dependencies: { react: "^19.0.0", lodash: "^4.17.21", dayjs: "^1.11.0" } });
    const changes = diffDependencies({ path: "package.json", before, after });
    expect(changes).toEqual([
      {
        kind: "changed",
        from: expect.objectContaining({ name: "react" }),
        to: expect.objectContaining({ version: "^19.0.0" }),
        major: true,
      },
      {
        kind: "changed",
        from: expect.objectContaining({ name: "lodash" }),
        to: expect.objectContaining({ version: "^4.17.21" }),
        major: false,
      },
      { kind: "added", dep: { name: "dayjs", version: "^1.11.0", group: "runtime" } },
      { kind: "removed", dep: { name: "moment", version: "^2.30.0", group: "runtime" } },
    ]);
  });

  it("treats a new or deleted manifest as all added or all removed", () => {
    const text = JSON.stringify({ require: { "symfony/console": "^7.3" } });
    expect(diffDependencies({ path: "composer.json", after: text }).map((c) => c.kind)).toEqual(["added"]);
    expect(diffDependencies({ path: "composer.json", before: text }).map((c) => c.kind)).toEqual(["removed"]);
  });

  it("reports nothing when only non-dependency fields change", () => {
    const before = JSON.stringify({ name: "a", dependencies: { x: "1.0.0" } });
    const after = JSON.stringify({ name: "a", exports: "./index.js", dependencies: { x: "1.0.0" } });
    expect(diffDependencies({ path: "package.json", before, after })).toEqual([]);
  });
});
