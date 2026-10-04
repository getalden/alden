import picomatch from "picomatch";
import { parse as parseToml } from "smol-toml";

/** A manifest file's content before and after the change. `undefined` means the file didn't exist on that side. */
export interface ManifestSnapshot {
  path: string;
  before?: string;
  after?: string;
}

export type DependencyGroup = "runtime" | "dev" | "peer" | "optional";

export interface Dependency {
  name: string;
  version: string;
  group: DependencyGroup;
}

export type DependencyChange =
  | { kind: "added"; dep: Dependency }
  | { kind: "removed"; dep: Dependency }
  | { kind: "changed"; from: Dependency; to: Dependency; major: boolean };

/** Manifests Alden can read, one per supported ecosystem. */
export const isManifest = picomatch(
  ["**/package.json", "**/composer.json", "**/go.mod", "**/requirements*.txt", "**/pyproject.toml", "**/Cargo.toml"],
  { dot: true },
);

type Parsed = Map<string, Dependency>;

function add(map: Parsed, name: string, version: string, group: DependencyGroup): void {
  // A package listed in two groups (e.g. dev and peer) is keyed per group.
  map.set(`${group}:${name}`, { name, version, group });
}

function parsePackageJson(text: string): Parsed {
  const json = JSON.parse(text) as Record<string, unknown>;
  const map: Parsed = new Map();
  const groups: [string, DependencyGroup][] = [
    ["dependencies", "runtime"],
    ["devDependencies", "dev"],
    ["peerDependencies", "peer"],
    ["optionalDependencies", "optional"],
  ];
  for (const [key, group] of groups) {
    const section = json[key];
    if (section && typeof section === "object") {
      for (const [name, version] of Object.entries(section)) add(map, name, String(version), group);
    }
  }
  return map;
}

function parseComposerJson(text: string): Parsed {
  const json = JSON.parse(text) as Record<string, unknown>;
  const map: Parsed = new Map();
  for (const [key, group] of [
    ["require", "runtime"],
    ["require-dev", "dev"],
  ] as const) {
    const section = json[key];
    if (section && typeof section === "object") {
      for (const [name, version] of Object.entries(section)) {
        // `php` and `ext-*` are platform requirements, not packages.
        if (name !== "php" && !name.startsWith("ext-")) add(map, name, String(version), group);
      }
    }
  }
  return map;
}

function parseGoMod(text: string): Parsed {
  const map: Parsed = new Map();
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line.startsWith("require (")) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ")") {
      inBlock = false;
      continue;
    }
    const spec = inBlock ? line : line.startsWith("require ") ? line.slice(8).trim() : "";
    const [name, version] = spec.split(/\s+/);
    if (name && version) add(map, name, version, raw.includes("// indirect") ? "optional" : "runtime");
  }
  return map;
}

const PEP508 = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/;

function addPep508(map: Parsed, spec: string, group: DependencyGroup): void {
  const clean = spec.replace(/\s*[;#].*$/, "").trim();
  const match = PEP508.exec(clean);
  if (match?.[1]) add(map, match[1].toLowerCase(), (match[3] ?? "").trim() || "*", group);
}

function parseRequirements(text: string, path: string): Parsed {
  const map: Parsed = new Map();
  const group: DependencyGroup = /dev|test/i.test(path) ? "dev" : "runtime";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue; // comments, -r, -e, --index-url
    addPep508(map, trimmed, group);
  }
  return map;
}

/** The parts of pyproject.toml that list dependencies: PEP 621, PEP 735 groups, and Poetry. */
interface Pyproject {
  project?: { dependencies?: unknown[]; "optional-dependencies"?: Record<string, unknown[]> };
  "dependency-groups"?: Record<string, unknown[]>;
  tool?: {
    poetry?: {
      dependencies?: Record<string, unknown>;
      "dev-dependencies"?: Record<string, unknown>;
      group?: Record<string, { dependencies?: Record<string, unknown> }>;
    };
  };
}

function parsePyproject(text: string): Parsed {
  const toml = parseToml(text) as Pyproject;
  const map: Parsed = new Map();
  for (const spec of toml.project?.dependencies ?? []) addPep508(map, String(spec), "runtime");
  for (const specs of Object.values(toml.project?.["optional-dependencies"] ?? {})) {
    for (const spec of specs) addPep508(map, String(spec), "optional");
  }
  for (const specs of Object.values(toml["dependency-groups"] ?? {})) {
    // Groups may also include other groups as tables; only strings are packages.
    for (const spec of specs) if (typeof spec === "string") addPep508(map, spec, "dev");
  }
  const poetry = toml.tool?.poetry;
  const poetryDeps = (section: Record<string, unknown> | undefined, group: DependencyGroup) => {
    for (const [name, value] of Object.entries(section ?? {})) {
      if (name === "python") continue;
      const version = typeof value === "string" ? value : String((value as { version?: string })?.version ?? "*");
      add(map, name.toLowerCase(), version, group);
    }
  };
  poetryDeps(poetry?.dependencies, "runtime");
  poetryDeps(poetry?.["dev-dependencies"], "dev");
  for (const g of Object.values(poetry?.group ?? {})) poetryDeps(g.dependencies, "dev");
  return map;
}

type CargoDeps = Record<string, unknown>;
interface CargoToml {
  dependencies?: CargoDeps;
  "dev-dependencies"?: CargoDeps;
  "build-dependencies"?: CargoDeps;
  workspace?: { dependencies?: CargoDeps };
  target?: Record<
    string,
    { dependencies?: CargoDeps; "dev-dependencies"?: CargoDeps; "build-dependencies"?: CargoDeps }
  >;
}

/** Cargo.toml: the main, dev and build tables, the workspace's shared versions, and per-target tables. */
function parseCargoToml(text: string): Parsed {
  const toml = parseToml(text) as CargoToml;
  const map: Parsed = new Map();
  const deps = (section: CargoDeps | undefined, group: DependencyGroup) => {
    for (const [name, value] of Object.entries(section ?? {})) {
      // `{ path = "..." }` and `{ workspace = true }` carry no version of their own.
      const version = typeof value === "string" ? value : (value as { version?: unknown })?.version;
      if (typeof version === "string") add(map, name, version, group);
    }
  };
  for (const tables of [toml, ...Object.values(toml.target ?? {})]) {
    deps(tables.dependencies, "runtime");
    deps(tables["dev-dependencies"], "dev");
    deps(tables["build-dependencies"], "dev");
  }
  deps(toml.workspace?.dependencies, "runtime");
  return map;
}

/** Reads a manifest's dependencies. Throws on unparseable content, which the check reports as skipped. */
export function parseManifest(path: string, text: string): Parsed {
  const name = path.split("/").at(-1) ?? path;
  if (name === "package.json") return parsePackageJson(text);
  if (name === "composer.json") return parseComposerJson(text);
  if (name === "go.mod") return parseGoMod(text);
  if (name === "pyproject.toml") return parsePyproject(text);
  if (/^requirements.*\.txt$/.test(name)) return parseRequirements(text, path);
  if (name === "Cargo.toml") return parseCargoToml(text);
  return new Map();
}

/** The first number in a version spec, or "0.minor" for 0.x (where minor bumps break). */
export function breakingPart(version: string): string | undefined {
  const match = /(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) return undefined;
  return match[1] === "0" ? `0.${match[2] ?? "0"}` : match[1];
}

export function isMajorChange(from: string, to: string): boolean {
  const a = breakingPart(from);
  const b = breakingPart(to);
  return a !== undefined && b !== undefined && a !== b;
}

/** What changed between two versions of a manifest. */
export function diffDependencies(snapshot: ManifestSnapshot): DependencyChange[] {
  const before = snapshot.before === undefined ? new Map() : parseManifest(snapshot.path, snapshot.before);
  const after = snapshot.after === undefined ? new Map() : parseManifest(snapshot.path, snapshot.after);
  const changes: DependencyChange[] = [];
  for (const [key, dep] of after) {
    const old = before.get(key);
    if (!old) changes.push({ kind: "added", dep });
    else if (old.version !== dep.version) {
      changes.push({ kind: "changed", from: old, to: dep, major: isMajorChange(old.version, dep.version) });
    }
  }
  for (const [key, dep] of before) if (!after.has(key)) changes.push({ kind: "removed", dep });
  return changes;
}
