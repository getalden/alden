import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createResolver, loadResolverConfig, parseGoMod } from "./resolve.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alden-resolve-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("reads tsconfig aliases (comments and trailing commas allowed), workspace packages and Python roots", async () => {
  await writeFile(
    join(root, "tsconfig.json"),
    `{
  // editor settings
  "compilerOptions": {
    "baseUrl": ".", /* where aliases start */
    "paths": { "@/*": ["web/src/*"], "~config": ["config/index.ts"], },
  },
}`,
  );
  await mkdir(join(root, "packages/core"), { recursive: true });
  await writeFile(join(root, "packages/core/package.json"), JSON.stringify({ name: "@acme/core" }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "root-is-not-a-workspace-package" }));

  const files = [
    "package.json",
    "packages/core/package.json",
    "packages/core/src/index.ts",
    "web/src/lib/api.ts",
    "config/index.ts",
    "src/app/__init__.py",
    "src/app/models.py",
  ];
  const config = await loadResolverConfig(root, files);
  expect(config.packages).toEqual(new Map([["@acme/core", "packages/core"]]));
  expect(config.pythonRoots.sort()).toEqual(["", "src"]);

  const resolve = createResolver(files, config);
  expect(resolve("web/src/pages/home.tsx", "@/lib/api")).toBe("web/src/lib/api.ts");
  expect(resolve("web/src/pages/home.tsx", "~config")).toBe("config/index.ts");
  expect(resolve("web/x.ts", "@acme/core")).toBe("packages/core/src/index.ts");
  expect(resolve("web/x.ts", "react")).toBeUndefined();
  expect(resolve("src/app/views.py", "app.models")).toBe("src/app/models.py");
  expect(resolve("src/app/views.py", ".models")).toBe("src/app/models.py");
  expect(resolve("src/app/views.py", "app")).toBe("src/app/__init__.py");
  expect(resolve("src/app/views.py", "django.db")).toBeUndefined();
});

it("works without any tsconfig", async () => {
  const config = await loadResolverConfig(root, ["a.ts"]);
  expect(config.aliases).toEqual([]);
});

it("parses go.mod module paths and local replaces", () => {
  const gomod = `module github.com/acme/app

go 1.23

require github.com/acme/lib v1.2.0

replace github.com/acme/lib => ./third_party/lib

replace (
\tgithub.com/acme/tools v0.1.0 => ../tools
\tgithub.com/acme/sdk => ./sdk
\tgolang.org/x/net => golang.org/x/net v0.30.0
)
`;
  expect(parseGoMod(gomod, "")).toEqual([
    { path: "github.com/acme/app", dir: "" },
    { path: "github.com/acme/lib", dir: "third_party/lib" },
    { path: "github.com/acme/sdk", dir: "sdk" },
  ]);
  expect(parseGoMod("module example.com/svc\n", "services/svc")).toEqual([
    { path: "example.com/svc", dir: "services/svc" },
  ]);
});

it("resolves Go import paths to package directories, preferring nested modules", async () => {
  await writeFile(join(root, "go.mod"), "module github.com/acme/app\n");
  await mkdir(join(root, "tools"), { recursive: true });
  await writeFile(join(root, "tools/go.mod"), "module github.com/acme/app/tools\n");
  const files = [
    "go.mod",
    "main.go",
    "internal/config/config.go",
    "internal/config/config_test.go",
    "internal/testdata/only_test.go",
    "tools/go.mod",
    "tools/gen/gen.go",
    "vendor/github.com/x/y/go.mod",
  ];
  const config = await loadResolverConfig(root, files);
  expect(config.goModules).toEqual([
    { path: "github.com/acme/app", dir: "" },
    { path: "github.com/acme/app/tools", dir: "tools" },
  ]);
  const resolve = createResolver(files, config);
  expect(resolve("main.go", "github.com/acme/app/internal/config")).toBe("internal/config");
  expect(resolve("main.go", "github.com/acme/app")).toBe("");
  expect(resolve("main.go", "github.com/acme/app/tools/gen")).toBe("tools/gen");
  // A directory with only tests isn't a package anyone imports; external modules aren't ours.
  expect(resolve("main.go", "github.com/acme/app/internal/testdata")).toBeUndefined();
  expect(resolve("main.go", "github.com/other/lib")).toBeUndefined();
  expect(resolve("main.go", "fmt")).toBeUndefined();
});
