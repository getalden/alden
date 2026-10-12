/**
 * Screenshots of the UI over the demo data, for the site, the docs, the README and marketing: `pnpm screenshots`.
 *
 * Starts `pnpm ui:demo` four times on their own ports (as a browser sees Alden, as the desktop app's window does,
 * with no model, for "Set up a model", and signed out with no model, for the first run), all with a throwaway
 * ALDEN_HOME (never yours), seeded with a few ranking rules so Settings → Ranking has something to show. Then a
 * headless Chrome with a throwaway profile, driven over the DevTools protocol, writes PNGs to
 * site/src/assets/screens (or ALDEN_SCREENS_OUT, to look without replacing the site's). Build the UI first. No
 * network: the demo is offline.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, launchChrome, sleep } from "./chrome.js";
import { HELPERS, ROOT, startDemos } from "./demo-pages.js";

const OUT = process.env.ALDEN_SCREENS_OUT ?? join(ROOT, "site/src/assets/screens");
const CDP_PORT = 9339;

/**
 * The demos: as a browser sees Alden, as the desktop app's window does, with no model set up, and someone new (no
 * GitHub sign-in, no model) for the first run.
 */
const DEMOS = {
  web: { port: 4329, env: {} },
  desktop: { port: 4330, env: { ALDEN_DEMO_DESKTOP: "1" } },
  noModel: { port: 4331, env: { ALDEN_DEMO_NO_MODEL: "1" } },
  firstRun: { port: 4332, env: { ALDEN_DEMO_FIRST_RUN: "1", ALDEN_DEMO_NO_MODEL: "1" } },
} as const;
type Demo = keyof typeof DEMOS;

/** What a reviewer might have set in Settings → Ranking, over the demo's recorded PRs. */
const RANKING = `[queue.rank]
waiting = 2
size = 0.5

[[queue.rank.rules]]
when = { path = "git/" }
then = "first"

[[queue.rank.rules]]
when = { author = "bots" }
then = "last"

[[queue.rank.rules]]
when = { label = "needs work" }
then = "lower"
by = 3
`;

const home = mkdtempSync(join(tmpdir(), "alden-shots-home-"));
mkdirSync(OUT, { recursive: true });
writeFileSync(join(home, "config.toml"), RANKING);
const demos = await startDemos(Object.values(DEMOS), home);
const chrome = await launchChrome(CDP_PORT).catch(async (error: unknown) => {
  await demos.stop();
  throw error;
});
try {
  const { cdp } = chrome;
  const run = (expression: string) => evaluate(cdp, `${HELPERS}; const s = window.__shot; ${expression}`);

  const shot = async (
    name: string,
    options: {
      path: string;
      demo?: Demo;
      width?: number;
      height?: number;
      dark?: boolean;
      /** Brief the PR first (checks only). */
      brief?: boolean;
      /** Script to run in the page before the shot, with `s` the helpers above. */
      steps?: string;
      /** Carry on in the page as the last shot left it, rather than opening `path` afresh. */
      stay?: boolean;
    },
  ) => {
    const { port } = DEMOS[options.demo ?? "web"];
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: options.width ?? 1440,
      height: options.height ?? 900,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: options.dark === false ? "light" : "dark" }],
    });
    if (!options.stay) {
      // Each shot starts from a clean window: no remembered filters, tab or drawer state.
      await cdp.send("Page.navigate", { url: "about:blank" });
      await cdp.send("Storage.clearDataForOrigin", { origin: `http://127.0.0.1:${port}`, storageTypes: "all" });
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}${options.path}#t=demo` });
      await sleep(1_500);
    }
    if (options.brief) await run("await s.brief();");
    if (options.steps) await run(options.steps);
    await run("await document.fonts.ready; document.activeElement?.blur?.();");
    await sleep(400);
    const { data } = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`wrote ${name}.png`);
  };

  // The site's home page and the README.
  await shot("briefing-dark", { path: "/pr/django/django/19057", brief: true });
  await shot("briefing-light", { path: "/pr/django/django/19057", dark: false, brief: true });
  await shot("queue-dark", { path: "/" });
  await shot("memory-dark", { path: "/memory" });
  await shot("memory-light", { path: "/memory", dark: false });
  await shot("stats-dark", { path: "/stats" });
  await shot("narrow-dark", { path: "/pr/vercel/next.js/99367", width: 420, height: 860, brief: true });

  // The docs: the web UI and the desktop app.
  await shot("queue-filters-dark", {
    path: "/pr/django/django/19057",
    brief: true,
    steps: `await s.key("s"); await s.click("Filter"); await s.select("Repository", "django/django"); await s.select("CI", "passing");`,
  });
  // The reading steps, 2 Walk through and 3 Diff, in both themes.
  for (const dark of [true, false]) {
    const theme = dark ? "dark" : "light";
    await shot(`diff-${theme}`, {
      path: "/pr/cli/cli/10513",
      dark,
      brief: true,
      steps: `await s.key("s"); await s.key("d"); await s.sleep(800); await s.key("]");`,
    });
    await shot(`guided-${theme}`, {
      path: "/pr/cli/cli/10513",
      dark,
      brief: true,
      steps: `await s.key("s"); await s.key("g"); await s.sleep(800);`,
    });
  }
  // The Tune popover from the model line, with a question asked (the demo's answer is canned; no model is called).
  await shot("tune-dark", {
    path: "/pr/django/django/19057",
    brief: true,
    steps: `await s.key("s"); document.querySelector(".model-line").click(); await s.sleep(400);
      (await s.until(() => document.querySelector('.tune-popover [aria-label^="Model:"]'))).click(); await s.sleep(300);
      [...document.querySelectorAll('[role="menuitemradio"]')].find((b) => b.textContent.startsWith("claude-sonnet-5"))?.click();
      await s.sleep(400);
      const ask = await s.until(() => document.querySelector(".ask-input"));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(ask, "Is the lookup fix safe for annotations on related fields?");
      ask.dispatchEvent(new Event("input", { bubbles: true }));
      ask.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await s.until(() => document.querySelector(".ask-foot")?.textContent.includes("$"), 8000);`,
  });
  await shot("comments-dark", { path: "/pr/cli/cli/10513", height: 1100, brief: true, steps: `await s.key("[");` });
  await shot("comments-light", {
    path: "/pr/cli/cli/10513",
    height: 1100,
    dark: false,
    brief: true,
    steps: `await s.key("[");`,
  });
  // The send dialog over the drawer: Approve, with what posts and the place Alden flagged that has no comment.
  // The demo never sends; this is the dialog before Send review.
  await shot("send-dark", {
    path: "/pr/cli/cli/10513",
    brief: true,
    steps: `await s.click("Approve"); await s.click("Review and send"); await s.until(() => document.querySelector(".send-dialog"));`,
  });
  await shot("ranking-dark", {
    path: "/settings",
    width: 1100,
    height: 1100,
    steps: `const h = await s.until(() => document.querySelector("#ranking-title")); h.style.scrollMarginTop = "64px"; h.scrollIntoView({ block: "start" });`,
  });
  await shot("model-setup-dark", {
    path: "/pr/django/django/19057",
    demo: "noModel",
    steps: `(await s.until(() => document.querySelector(".model-line"))).click(); await s.sleep(300);
      await s.click("Set up a model"); await s.until(() => document.querySelector("#model-setup-title")); await s.sleep(600);`,
  });
  // A briefing the app prepared while you were away, as the window shows it (callers off: the demo has no clones).
  await shot("desktop-ready-dark", {
    path: "/pr/django/django/19057",
    demo: "desktop",
    width: 1280,
    height: 840,
    steps: `await s.key("s");`,
  });
  await shot("desktop-settings-dark", {
    path: "/settings",
    demo: "desktop",
    width: 1280,
    height: 840,
    steps: `const h = [...document.querySelectorAll("h2")].find((h) => h.textContent === "Command line tool"); h.style.scrollMarginTop = "64px"; h.scrollIntoView({ block: "start" });`,
  });
  // The first run, as someone new sees it: sign in, pick how Alden thinks, land in the ranked queue. Signing in is
  // pretend (the demo's code is DEMO-1234 and it "signs in" a few seconds later); the model step goes on with checks
  // only, so nothing is typed. One page through all three steps: once signed in, the first run doesn't open again.
  await shot("first-run-signin-dark", {
    path: "/",
    demo: "firstRun",
    width: 1100,
    height: 760,
    steps: `await s.until(() => document.querySelector(".first-run-card"));`,
  });
  await shot("first-run-model-dark", {
    path: "/",
    demo: "firstRun",
    width: 1100,
    height: 760,
    stay: true,
    steps: `await s.click("Continue with GitHub");
      await s.until(() => document.querySelector('.first-run-card[data-step="2"]'), 15000);
      await s.until(() => document.querySelector(".first-run-option"));`,
  });
  await shot("first-run-queue-dark", {
    path: "/",
    demo: "firstRun",
    width: 1100,
    height: 760,
    stay: true,
    steps: `await s.click("Checks only"); await s.click("Continue");
      await s.until(() => document.querySelector(".first-run-rows"), 15000);`,
  });
  cdp.close();
} finally {
  await chrome.stop();
  await demos.stop();
  rmSync(home, { recursive: true, force: true });
}
