/**
 * Checks a built `alden` binary works on this machine: `pnpm smoke:binary dist-bin/alden-<target>`.
 *
 * Its version, a local review of a throwaway repo (diff, checks and the code graph with the embedded grammars, no
 * model), the local database, and `alden ui` serving the embedded UI. Uses a throwaway ALDEN_HOME and never touches the keychain.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = resolve(process.argv[2] ?? "");
const expectedVersion = (
  JSON.parse(readFileSync(join(import.meta.dirname, "../packages/cli/package.json"), "utf8")) as {
    version: string;
  }
).version;
const home = mkdtempSync(join(tmpdir(), "alden-smoke-home-"));
const repo = mkdtempSync(join(tmpdir(), "alden-smoke-repo-"));
const env = { ...process.env, ALDEN_HOME: home, ALDEN_GITHUB_TOKEN: "smoke-test-not-a-token", NO_COLOR: "1" };
const run = (args: string[], cwd = repo) =>
  execFileSync(binary, args, { cwd, env, encoding: "utf8", timeout: 120_000 });
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  failed ||= !ok;
};

try {
  const version = run(["--version"]).trim();
  check("version", version === expectedVersion, version);

  // A repo where a changed function signature is still called from another file.
  git("init", "-q", "-b", "main");
  git("config", "user.email", "smoke@example.com");
  git("config", "user.name", "Smoke");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/rank.ts"), "export function rank(queue: string[]) {\n  return queue;\n}\n");
  writeFileSync(join(repo, "src/cli.ts"), 'import { rank } from "./rank";\nrank([]);\n');
  writeFileSync(join(repo, "src/app.py"), "def charge(card):\n    return card\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(
    join(repo, "src/rank.ts"),
    "export function rank(queue: string[], now: number) {\n  return queue;\n}\n",
  );
  const review = run(["review", "--no-llm"]);
  check("review finds the caller with the code graph", /calls rank \(signature changed\)/.test(review));
  check("review runs every check", /Likely secrets/.test(review) && /Changed public signatures/.test(review));

  // The local database (node:sqlite, as Bun implements it): a note goes in and comes back out.
  run(["memory", "add", "--repo", "smoke/test", "Money is in cents"]);
  check("memory keeps a note in the database", run(["memory", "--repo", "smoke/test"]).includes("Money is in cents"));

  // The web UI, served from inside the binary.
  const ui = spawn(binary, ["ui", "--no-open", "--port", "0"], { cwd: repo, env });
  const url = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("alden ui didn't start in 20s")), 20_000);
    ui.stdout.on("data", (chunk: Buffer) => {
      const match = /http:\/\/127\.0\.0\.1:\d+\/#t=\S+/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        done(match[0]);
      }
    });
  });
  const base = url.split("#")[0] as string;
  const html = await (await fetch(base)).text();
  check("ui serves the app", html.includes('<div id="root">'));
  const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  const asset = script ? await fetch(`${base}${script.slice(1)}`) : undefined;
  check("ui serves its assets", asset?.status === 200);
  const token = url.split("#t=")[1] as string;
  const session = await fetch(`${base}api/session`, { headers: { "X-Alden-Token": token } });
  check("ui answers the API with the session key", session.status === 200);
  check("ui refuses the API without it", (await fetch(`${base}api/session`)).status === 401);
  ui.kill();
} catch (error) {
  check("smoke test", false, (error as Error).message);
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
