import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createResolver, loadResolverConfig } from "./resolve.js";

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
