import { readFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

/**
 * Turns an import as written into a repo path, or undefined for external packages and anything unresolvable. Go
 * imports name a package, so for Go the path is the package's directory ("" for the repo root).
 */
export type Resolver = (fromFile: string, specifier: string) => string | undefined;

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** A path alias from tsconfig: "@/*" → ["src/*"], relative to the repo root. */
interface Alias {
  prefix: string;
  suffix: string;
  targets: string[];
}

export interface ResolverConfig {
  /** tsconfig `paths`, already made relative to the repo root. */
  aliases: Alias[];
  /** Workspace package name → the package's directory, e.g. "@alden/core" → "packages/core". */
  packages: Map<string, string>;
  /** Directories Python imports may be rooted at: "" (the repo root), "src", "backend", … */
  pythonRoots: string[];
  /** Go modules in the repo, from go.mod files (and local `replace` targets): module path → directory. */
  goModules?: GoModule[];
}

export interface GoModule {
  path: string;
  dir: string;
}

function tsCandidates(base: string): string[] {
  // ESM TypeScript writes "./x.js" for ./x.ts.
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  return [
    base,
    ...TS_EXTENSIONS.map((ext) => `${stripped}${ext}`),
    ...TS_EXTENSIONS.map((ext) => `${stripped}/index${ext}`),
  ];
}

function pythonCandidates(root: string, dotted: string): string[] {
  const path = posix.join(root, dotted.replace(/\./g, "/"));
  return [`${path}.py`, `${path}/__init__.py`];
}

/**
 * A resolver over the repo's own files. TypeScript: relative imports (ESM `.js` meaning `.ts`), index files, tsconfig
 * path aliases and workspace packages. Python: absolute module paths from each source root, relative imports, and
 * packages (`__init__.py`). Go: import paths under the repo's modules, to the package's directory.
 */
export function createResolver(files: Iterable<string>, config: ResolverConfig): Resolver {
  const known = new Set(files);
  const first = (candidates: string[]) => candidates.find((c) => known.has(c));
  // Directories that hold a Go package: any non-test .go file.
  const goDirs = new Set<string>();
  for (const file of known) {
    if (file.endsWith(".go") && !file.endsWith("_test.go")) goDirs.add(dirOf(file));
  }
  // Longest module path first, so a nested module wins over the one containing it.
  const goModules = [...(config.goModules ?? [])].sort((a, b) => b.path.length - a.path.length);

  return (fromFile, specifier) => {
    if (fromFile.endsWith(".go")) {
      for (const module of goModules) {
        if (specifier !== module.path && !specifier.startsWith(`${module.path}/`)) continue;
        const dir = posix.join(module.dir || ".", specifier.slice(module.path.length).replace(/^\//, ""));
        const normal = dir === "." ? "" : dir;
        return goDirs.has(normal) ? normal : undefined;
      }
      return undefined;
    }

    if (fromFile.endsWith(".py")) {
      if (specifier.startsWith(".")) {
        // ".utils" is this package; each extra dot goes up one level.
        const dots = /^\.+/.exec(specifier)?.[0].length ?? 1;
        let base = posix.dirname(fromFile);
        for (let i = 1; i < dots; i++) base = posix.dirname(base);
        const rest = specifier.slice(dots);
        if (!rest) return first([posix.join(base, "__init__.py")]);
        return first(pythonCandidates(base === "." ? "" : base, rest));
      }
      for (const root of config.pythonRoots) {
        const hit = first(pythonCandidates(root, specifier));
        if (hit) return hit;
      }
      return undefined;
    }

    if (specifier.startsWith("."))
      return first(tsCandidates(posix.normalize(posix.join(posix.dirname(fromFile), specifier))));
    for (const alias of config.aliases) {
      if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) continue;
      const middle = specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
      for (const target of alias.targets) {
        const hit = first(tsCandidates(posix.normalize(target.replace("*", middle))));
        if (hit) return hit;
      }
    }
    // Workspace packages: "@alden/core" or "@alden/core/sub".
    for (const [name, dir] of config.packages) {
      if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
      const sub = specifier.slice(name.length).replace(/^\//, "");
      const bases = sub
        ? [posix.join(dir, "src", sub), posix.join(dir, sub)]
        : [posix.join(dir, "src/index"), posix.join(dir, "index")];
      for (const base of bases) {
        const hit = first(tsCandidates(base));
        if (hit) return hit;
      }
    }
    return undefined;
  };
}

/** "a/b/c.go" → "a/b"; files at the root are in "". */
export function dirOf(path: string): string {
  const dir = posix.dirname(path);
  return dir === "." ? "" : dir;
}

/**
 * The module a go.mod declares, plus local `replace` targets (`replace example.com/lib => ../lib`), which make another
 * directory answer for a module path.
 */
export function parseGoMod(text: string, dir: string): GoModule[] {
  const modules: GoModule[] = [];
  const declared = /^\s*module\s+"?([^\s"]+)"?/m.exec(text)?.[1];
  if (declared) modules.push({ path: declared, dir });
  // Single-line and block replaces: "old [version] => ./path"; only local paths (starting with . or /) are ours.
  for (const match of text.matchAll(
    /^\s*(?:replace\s+)?([^\s()]+)(?:\s+v[^\s]+)?\s+=>\s+(\.{1,2}\/[^\s]*|\.{1,2})\s*$/gm,
  )) {
    const [, path, target] = match;
    if (!path || !target || path === "replace") continue;
    const joined = posix.normalize(posix.join(dir || ".", target));
    if (joined.startsWith("..")) continue; // outside the repo
    modules.push({ path, dir: joined === "." ? "" : joined });
  }
  return modules;
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    // tsconfig allows comments and trailing commas; strip the common forms before parsing.
    const text = (await readFile(path, "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'])\/\/.*$/gm, "$1")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Reads what resolution needs from the repo: path aliases from the root tsconfig (or jsconfig), workspace packages
 * from every package.json the repo tracks, likely Python source roots, and Go modules from every go.mod.
 */
export async function loadResolverConfig(root: string, allFiles: string[]): Promise<ResolverConfig> {
  const aliases: Alias[] = [];
  for (const name of ["tsconfig.json", "tsconfig.base.json", "jsconfig.json"]) {
    const config = await readJson(join(root, name));
    const options = config?.compilerOptions as { baseUrl?: string; paths?: Record<string, string[]> } | undefined;
    if (!options?.paths) continue;
    const baseUrl = options.baseUrl ?? ".";
    for (const [pattern, targets] of Object.entries(options.paths)) {
      const star = pattern.indexOf("*");
      aliases.push({
        prefix: star === -1 ? pattern : pattern.slice(0, star),
        suffix: star === -1 ? "" : pattern.slice(star + 1),
        targets: targets.map((t) => posix.normalize(posix.join(baseUrl, t))),
      });
    }
    break;
  }

  const packages = new Map<string, string>();
  for (const file of allFiles.filter((f) => f.endsWith("package.json") && !f.includes("node_modules/"))) {
    const pkg = await readJson(join(root, file));
    if (typeof pkg?.name === "string" && file !== "package.json") packages.set(pkg.name, dirname(file));
  }

  // Python roots: the repo root, plus any top-level directory holding packages (e.g. src/, backend/, BE/).
  const roots = new Set<string>([""]);
  for (const file of allFiles) {
    if (!file.endsWith("/__init__.py")) continue;
    const top = file.split("/")[0] ?? "";
    if (file.split("/").length > 2) roots.add(top);
  }

  // Go modules: every tracked go.mod outside vendored code. (go.work only lists directories that have their own go.mod.)
  const goModules: GoModule[] = [];
  for (const file of allFiles.filter((f) => /(^|\/)go\.mod$/.test(f) && !/(^|\/)vendor\//.test(f))) {
    try {
      goModules.push(...parseGoMod(await readFile(join(root, file), "utf8"), dirOf(file)));
    } catch {
      // unreadable go.mod: its imports stay unresolved
    }
  }
  return { aliases, packages, pythonRoots: [...roots], goModules };
}
