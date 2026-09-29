import { execFileSync } from "node:child_process";
import { indexRepo } from "./src/graph/index-repo.js";
import { CodeGraph } from "./src/graph/query.js";
import { createResolver, loadResolverConfig } from "./src/graph/resolve.js";

const [root, cacheDir, target] = process.argv.slice(2) as [string, string, string];
let t = Date.now();
const idx = await indexRepo(root, { cacheDir, budgetMs: 600_000 });
const indexMs = Date.now() - t;
const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\n")
  .filter(Boolean);
t = Date.now();
const config = await loadResolverConfig(root, tracked);
const graph = new CodeGraph(idx.files, createResolver(idx.files.keys(), config));
const graphMs = Date.now() - t;
const [path, name, container] = target.split(":") as [string, string, string?];
t = Date.now();
const sites = graph.callersOf({ path, name, ...(container ? { container } : {}) });
console.log({
  indexMs,
  files: idx.files.size,
  complete: idx.complete,
  modules: config.goModules?.length,
  graphMs,
  queryMs: Date.now() - t,
  callers: sites.length,
  sample: sites.slice(0, 3),
});
