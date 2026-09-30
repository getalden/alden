import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AldenConfigSchema, BriefingSchema, type BriefingTarget } from "@alden/schema";
import { describe, expect, it } from "vitest";
import type { DiffFile } from "../diff/parse.js";
import { fromRestFile } from "../diff/sources.js";
import { type RawPullRequest, toFacts } from "../github/pull-requests.js";
import { buildBriefing, runChecks } from "./briefing.js";
import {
  CHECKS,
  callersCheck,
  ciCheck,
  configCheck,
  dependenciesCheck,
  migrationsCheck,
  secretsCheck,
  sensitivePathsCheck,
  testsCheck,
} from "./checks.js";
import type { ReviewContext } from "./types.js";

const config = AldenConfigSchema.parse({});
const local: BriefingTarget = { kind: "local", repoRoot: "/repo", branch: "main" };
const prTarget: BriefingTarget = {
  kind: "pr",
  repo: "getalden/alden",
  number: 1,
  url: "https://github.com/getalden/alden/pull/1",
  title: "Change",
  author: "sam",
  baseRef: "main",
  headRef: "sam/change",
};

/** A changed file whose added lines are `added`, numbered from 1. */
function file(path: string, added: string[] = ["x"], overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    status: "modified",
    additions: added.length,
    deletions: 0,
    binary: false,
    patchMissing: false,
    hunks: [
      {
        header: `@@ -0,0 +1,${added.length} @@`,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: added.length,
        lines: added.map((text, i) => ({ kind: "add" as const, text, newLine: i + 1 })),
      },
    ],
    ...overrides,
  };
}

const ctx = (files: DiffFile[], extra: Partial<ReviewContext> = {}): ReviewContext => ({
  target: local,
  files,
  config,
  ...extra,
});

describe("ci.status", () => {
  const pr = (ci: "success" | "failure" | "pending" | "none") =>
    ({ ci, author: "sam" }) as unknown as NonNullable<ReviewContext["pr"]>;

  it("passes, flags or skips by CI state", () => {
    expect(ciCheck.run(ctx([], { target: prTarget, pr: pr("success") })).status).toBe("passed");
    const failing = ciCheck.run(ctx([], { target: prTarget, pr: pr("failure") }));
    expect(failing).toMatchObject({ status: "flagged", severity: "high" });
    expect(failing.summary).toContain("@sam");
    expect(ciCheck.run(ctx([], { target: prTarget, pr: pr("pending") })).status).toBe("skipped");
    expect(ciCheck.run(ctx([], { target: prTarget, pr: pr("none") })).summary).toMatch(/No CI ran/);
  });

  it("skips local changes", () => {
    expect(ciCheck.run(ctx([])).summary).toMatch(/local/);
  });
});

describe("tests.missing", () => {
  it("flags code without tests and points at the first added line", () => {
    const result = testsCheck.run(ctx([file("src/queue.ts", ["a", "b"]), file("README.md")]));
    expect(result).toMatchObject({ status: "flagged", severity: "medium" });
    expect(result.evidence).toEqual([
      { text: "no matching test change: src/queue.ts", anchor: { path: "src/queue.ts", line: 1 } },
    ]);
  });

  it("passes when tests changed too, and skips when no code changed", () => {
    expect(testsCheck.run(ctx([file("app/Models/User.php"), file("tests/Unit/UserTest.php")])).status).toBe("passed");
    expect(testsCheck.run(ctx([file("docs/intro.md")])).status).toBe("skipped");
  });

  it("ignores deleted code", () => {
    expect(testsCheck.run(ctx([file("src/old.go", [], { status: "removed" })])).status).toBe("skipped");
  });

  it("caps evidence at five with a count of the rest", () => {
    const result = testsCheck.run(ctx(Array.from({ length: 8 }, (_, i) => file(`src/f${i}.py`))));
    expect(result.evidence).toHaveLength(6);
    expect(result.evidence.at(-1)?.text).toBe("and 3 more");
  });
});

describe("migrations.changed", () => {
  it("passes when no migration changed", () => {
    expect(migrationsCheck.run(ctx([file("src/app.ts")])).status).toBe("passed");
  });

  it("flags a Laravel migration as medium when it only adds", () => {
    const result = migrationsCheck.run(
      ctx([file("database/migrations/2026_09_28_add_index.php", ["$table->index('email');"])]),
    );
    expect(result).toMatchObject({ status: "flagged", severity: "medium" });
  });

  it.each([
    ["Laravel", "database/migrations/2026_09_28_drop.php", "        $table->dropColumn('legacy_id');"],
    [
      "Django",
      "billing/migrations/0042_remove.py",
      "        migrations.RemoveField(model_name='invoice', name='old'),",
    ],
    ["SQL", "db/migrations/0003.up.sql", "ALTER TABLE users DROP COLUMN nickname;"],
    ["golang-migrate", "migrations/0004_cleanup.up.sql", "TRUNCATE sessions;"],
    ["Doctrine", "migrations/Version20260928.php", "$this->addSql('DROP TABLE legacy');"],
  ])("flags destructive %s operations as high, with the line", (_label, path, line) => {
    const result = migrationsCheck.run(ctx([file(path, ["// setup", line])]));
    expect(result.severity).toBe("high");
    expect(result.evidence[0]).toMatchObject({ anchor: { path, line: 2 } });
    expect(result.evidence[0]?.text).toMatch(/^may lose data: /);
  });
});

describe("config.changed", () => {
  it("passes when nothing config-like changed", () => {
    expect(configCheck.run(ctx([file("src/app.ts", ["const x = 1;"])])).status).toBe("passed");
  });

  it("flags config files", () => {
    const result = configCheck.run(ctx([file("config/queue.php"), file(".env.example"), file("Dockerfile")]));
    expect(result.status).toBe("flagged");
    expect(result.evidence.map((e) => e.text)).toEqual([
      "config: config/queue.php",
      "config: .env.example",
      "config: Dockerfile",
    ]);
  });

  it.each([
    ["Node", "src/a.ts", "const key = process.env.STRIPE_SECRET;"],
    ["Vite", "src/a.ts", "const url = import.meta.env.VITE_API_URL;"],
    ["Python", "app/a.py", "token = os.environ['SLACK_TOKEN']"],
    ["Python getenv", "app/a.py", "region = os.getenv('AWS_REGION', 'eu-west-1')"],
    ["Laravel", "app/a.php", "'key' => env('RESEND_KEY'),"],
    ["Symfony", "config/services.yaml", "    api_key: '%env(resolve:MAILER_DSN)%'"],
    ["Go", "cmd/a.go", 'port := os.Getenv("PORT")'],
  ])("spots newly read %s environment variables", (_label, path, line) => {
    const result = configCheck.run(ctx([file(path, [line])]));
    expect(result.evidence[0]?.text).toMatch(/^reads environment variable [A-Z_]+$/);
    expect(result.evidence[0]?.anchor).toEqual({ path, line: 1 });
  });

  it("doesn't count variables read only in tests", () => {
    expect(configCheck.run(ctx([file("tests/test_app.py", ["os.getenv('X')"])])).status).toBe("passed");
  });
});

describe("paths.sensitive", () => {
  it("flags files under sensitive paths, including a rename out of one", () => {
    const result = sensitivePathsCheck.run(
      ctx([
        file("src/app.ts"),
        file("src/session.ts", ["x"], { status: "renamed", previousPath: "app/auth/session.ts" }),
      ]),
    );
    expect(result.status).toBe("flagged");
    expect(result.evidence.map((e) => e.text)).toEqual(["renamed: src/session.ts"]);
  });

  it("uses the configured list", () => {
    const none = { ...config, queue: { ...config.queue, sensitivePaths: [] } };
    expect(sensitivePathsCheck.run(ctx([file("app/auth/x.ts")], { config: none })).status).toBe("passed");
  });
});

describe("dependencies.changed", () => {
  const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) =>
    JSON.stringify({ dependencies: deps, devDependencies: dev }, null, 2);

  it("passes when no manifest changed, and skips when manifests couldn't be read", () => {
    expect(dependenciesCheck.run(ctx([file("src/a.ts")])).status).toBe("passed");
    expect(dependenciesCheck.run(ctx([file("package.json")])).status).toBe("skipped");
  });

  it("flags a new runtime package as medium and points at the line naming it", () => {
    const manifest = file("package.json", ['    "dayjs": "^1.11.0",']);
    const result = dependenciesCheck.run(
      ctx([manifest], {
        manifests: [
          {
            path: "package.json",
            before: pkg({ react: "^19.0.0" }),
            after: pkg({ react: "^19.0.0", dayjs: "^1.11.0" }),
          },
        ],
      }),
    );
    expect(result).toMatchObject({
      status: "flagged",
      severity: "medium",
      summary: expect.stringMatching(/^1 dependency added\./),
    });
    expect(result.evidence).toEqual([
      { text: "added dayjs ^1.11.0 (runtime) in package.json", anchor: { path: "package.json", line: 1 } },
    ]);
  });

  it("flags only minor changes to dev tools as low", () => {
    const result = dependenciesCheck.run(
      ctx([file("package.json")], {
        manifests: [
          {
            path: "package.json",
            before: pkg({}, { vitest: "^5.0.0" }),
            after: pkg({}, { vitest: "^5.1.0", biome: "^2.5.0" }),
          },
        ],
      }),
    );
    expect(result).toMatchObject({ severity: "low", summary: "1 dependency added, 1 updated." });
  });

  it("flags major upgrades", () => {
    const result = dependenciesCheck.run(
      ctx([file("composer.json")], {
        manifests: [
          {
            path: "composer.json",
            before: JSON.stringify({ require: { "laravel/framework": "^12.0" } }),
            after: JSON.stringify({ require: { "laravel/framework": "^13.0" } }),
          },
        ],
      }),
    );
    expect(result.severity).toBe("medium");
    expect(result.evidence[0]?.text).toBe("major upgrade laravel/framework ^12.0 → ^13.0 in composer.json");
  });

  it("passes when a manifest changed but no dependency did", () => {
    const before = JSON.stringify({ name: "a", dependencies: { x: "1" } });
    const after = JSON.stringify({ name: "a", exports: "./i.js", dependencies: { x: "1" } });
    const result = dependenciesCheck.run(
      ctx([file("package.json")], { manifests: [{ path: "package.json", before, after }] }),
    );
    expect(result).toMatchObject({ status: "passed", summary: "Manifests changed, but no dependencies did." });
  });

  it("reports manifests it can't parse", () => {
    const result = dependenciesCheck.run(
      ctx([file("package.json")], { manifests: [{ path: "package.json", before: "{}", after: "{ broken" }] }),
    );
    expect(result.evidence[0]?.text).toBe("couldn't parse package.json");
  });
});

describe("secrets.likely", () => {
  const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;

  it("flags likely secrets as high with masked values and exact lines", () => {
    const result = secretsCheck.run(ctx([file("src/client.ts", ["import x from 'y';", `const t = "${token}";`])]));
    expect(result).toMatchObject({ status: "flagged", severity: "high" });
    expect(result.evidence).toEqual([
      { text: "GitHub token: ghp_…(44 chars)", anchor: { path: "src/client.ts", line: 2 } },
    ]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("skips lockfiles, binary files and deleted lines", () => {
    const deleted = file("src/old.ts", [], {
      hunks: [
        {
          header: "@@ -1 +0,0 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 0,
          newLines: 0,
          lines: [{ kind: "del", text: token, oldLine: 1 }],
        },
      ],
    });
    const result = secretsCheck.run(
      ctx([file("package-lock.json", [token]), file("a.bin", [token], { binary: true }), deleted]),
    );
    expect(result.status).toBe("passed");
  });
});

describe("runChecks", () => {
  it("reports a check that throws as skipped instead of failing the review", () => {
    const [result] = runChecks(ctx([]), [
      {
        id: "boom",
        title: "Boom",
        heuristic: false,
        run: () => {
          throw new Error("kaboom");
        },
      },
    ]);
    expect(result).toMatchObject({ id: "boom", status: "skipped", summary: "The check failed to run: kaboom" });
  });
});

describe("buildBriefing on every recorded real PR", () => {
  const FIXTURES = join(import.meta.dirname, "../github/__fixtures__");
  // Each fixture names its diffs: diffs/<fixture name>-<number>.json.
  const prs = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      const fixture = JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) as {
        name: string;
        pullRequests: RawPullRequest[];
      };
      return fixture.pullRequests.map((raw) => ({ name: fixture.name, raw }));
    });

  it.each(prs.map(({ name, raw }) => [`${raw.repository.nameWithOwner}#${raw.number}`, name, raw] as const))(
    "%s produces a valid briefing",
    (_label, name, raw) => {
      const diffPath = join(FIXTURES, "diffs", `${name}-${raw.number}.json`);
      const files = (JSON.parse(readFileSync(diffPath, "utf8")) as Parameters<typeof fromRestFile>[0][]).map(
        fromRestFile,
      );
      const pr = toFacts(raw, { login: "someone", teams: new Set() });
      const briefing = buildBriefing({
        target: { ...prTarget, repo: pr.repo, number: pr.number, url: pr.url, title: pr.title },
        files,
        pr,
        config,
      });

      expect(BriefingSchema.safeParse(JSON.parse(JSON.stringify(briefing))).error).toBeUndefined();
      expect(briefing.checks.map((c) => c.id)).toEqual(CHECKS.map((c) => c.id));
      expect(briefing.summary.files).toBe(files.length);
    },
  );
});

describe("callers.outside", () => {
  const change = (name: string, kind: "modified" | "removed" = "modified", exported = true) => ({
    path: "src/rank.ts",
    name,
    kind: "function" as const,
    exported,
    change: kind,
    startLine: 1,
    endLine: 3,
    changedLines: 1,
  });
  const graph = (
    changes: ReturnType<typeof change>[],
    callers: Record<string, { path: string; line: number; confidence: "import" | "name" }[]>,
    complete = true,
  ) => ({
    changes,
    callers: new Map(Object.entries(callers)),
    complete,
  });

  it("skips without a code graph, and passes when no public code changed", () => {
    expect(callersCheck.run(ctx([])).status).toBe("skipped");
    expect(callersCheck.run(ctx([], { graph: graph([change("helper", "modified", false)], {}) })).summary).toBe(
      "No public functions, classes or methods changed.",
    );
  });

  it("flags high when a removed symbol is still called", () => {
    const result = callersCheck.run(
      ctx([], {
        graph: graph([change("rankQueue", "removed")], {
          "src/rank.ts#rankQueue": [{ path: "src/cli.ts", line: 12, confidence: "import" }],
        }),
      }),
    );
    expect(result).toMatchObject({ status: "flagged", severity: "high" });
    expect(result.summary).toMatch(
      /^1 removed or re-signed public symbol still called from 1 place this PR didn't change/,
    );
    expect(result.evidence).toEqual([{ text: "calls rankQueue (removed)", anchor: { path: "src/cli.ts", line: 12 } }]);
  });

  it("treats a changed signature line as breaking", () => {
    const files = [
      {
        ...file("src/rank.ts", ["export function rankQueue(queue: Queue, now: number) {"]),
        hunks: [
          {
            header: "@@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { kind: "del" as const, text: "export function rankQueue(queue: Queue) {", oldLine: 1 },
              { kind: "add" as const, text: "export function rankQueue(queue: Queue, now: number) {", newLine: 1 },
            ],
          },
        ],
      },
    ];
    const result = callersCheck.run(
      ctx(files, {
        graph: graph([change("rankQueue")], {
          "src/rank.ts#rankQueue": [{ path: "src/cli.ts", line: 12, confidence: "import" }],
        }),
      }),
    );
    expect(result.severity).toBe("high");
    expect(result.evidence[0]?.text).toBe("calls rankQueue (signature changed)");
  });

  it("flags low when only the body changed, and counts name-only callers", () => {
    const result = callersCheck.run(
      ctx([], {
        graph: graph([change("formatAge")], {
          "src/rank.ts#formatAge": [
            { path: "src/a.ts", line: 3, confidence: "import" },
            { path: "src/b.js", line: 9, confidence: "name" },
          ],
        }),
      }),
    );
    expect(result).toMatchObject({ status: "flagged", severity: "low" });
    expect(result.summary).toBe(
      "1 changed public symbol called from 2 places outside the diff (1 by name only). Behaviour changes reach them.",
    );
    expect(result.evidence[1]?.text).toBe("calls formatAge (changed), name match only");
  });

  it("passes when changed public code has no outside callers, and says when the index was cut short", () => {
    const result = callersCheck.run(ctx([], { graph: graph([change("formatAge")], {}, false) }));
    expect(result).toMatchObject({ status: "passed" });
    expect(result.summary).toMatch(/cut short/);
  });
});
