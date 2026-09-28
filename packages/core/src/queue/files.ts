import picomatch from "picomatch";

export type FileKind = "docs" | "test" | "dependency" | "code" | "other";

const DOCS = picomatch(["**/*.{md,mdx,rst,txt,adoc}", "**/docs/**", "**/{LICENSE,LICENCE,AUTHORS,CHANGELOG}*"], {
  dot: true,
  nocase: true,
});

const TESTS = picomatch(
  [
    "**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}",
    "**/__tests__/**",
    "**/{test,tests}/**",
    "**/*_test.go",
    "**/test_*.py",
    "**/*_test.py",
    "**/*Test.php",
    "**/__snapshots__/**",
  ],
  { dot: true },
);

const DEPENDENCIES = picomatch(
  [
    "**/package.json",
    "**/{package-lock.json,pnpm-lock.yaml,yarn.lock,bun.lockb}",
    "**/{composer.json,composer.lock}",
    "**/{go.mod,go.sum}",
    "**/{requirements*.txt,pyproject.toml,poetry.lock,uv.lock,Pipfile,Pipfile.lock}",
  ],
  { dot: true },
);

const CODE = picomatch("**/*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte,py,php,go,rb,java,kt,rs,swift,dart,cs,c,cc,cpp,h}", {
  dot: true,
});

/** Tests win over code (a test is code), and dependency manifests win over docs (requirements.txt). */
export function fileKind(path: string): FileKind {
  if (TESTS(path)) return "test";
  if (DEPENDENCIES(path)) return "dependency";
  if (DOCS(path)) return "docs";
  if (CODE(path)) return "code";
  return "other";
}

/** A matcher for the user's sensitive-path globs. */
export function sensitiveMatcher(globs: string[]): (path: string) => boolean {
  return globs.length === 0 ? () => false : picomatch(globs, { dot: true });
}

const VERSION_BUMP = /\bfrom v?(\d+)\.(\d+)\.(\d+)\S* to v?(\d+)\.(\d+)\.(\d+)/i;

/** True for titles like Dependabot's "Bump lodash from 4.17.20 to 4.17.21" where only the patch version moves. */
export function isPatchBumpTitle(title: string): boolean {
  const m = VERSION_BUMP.exec(title);
  if (!m) return false;
  const [, fromMajor, fromMinor, fromPatch, toMajor, toMinor, toPatch] = m.map(Number);
  return fromMajor === toMajor && fromMinor === toMinor && (toPatch ?? 0) > (fromPatch ?? 0);
}
