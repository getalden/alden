/**
 * Screenshots of the UI over the demo data, for the site, the docs, the README and marketing: `pnpm screenshots`.
 *
 * Starts `pnpm ui:demo` three times on their own ports (as a browser sees Alden, as the desktop app's window does,
 * and with no model, for "Set up a model"), all with a throwaway ALDEN_HOME (never yours), seeded with a few ranking
 * rules so Settings → Ranking has something to show. Then a headless Chrome with a throwaway profile, driven over the
 * DevTools protocol, writes PNGs to site/src/assets/screens. Build the UI first. No network: the demo is offline.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "site/src/assets/screens");
const CDP_PORT = 9339;
const CHROME =
  process.env.CHROME ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");

/** The demos: as a browser sees Alden, as the desktop app's window does, and with no model set up. */
const DEMOS = {
  web: { port: 4329, env: {} },
  desktop: { port: 4330, env: { ALDEN_DEMO_DESKTOP: "1" } },
  noModel: { port: 4331, env: { ALDEN_DEMO_NO_MODEL: "1" } },
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url: string, tries = 80): Promise<Response> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`${url} never answered`);
}

/** A minimal DevTools protocol client: send a command, await its reply. */
async function connect(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map<number, (value: { result?: Record<string, unknown>; error?: unknown }) => void>();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown };
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const n = ++id;
      pending.set(n, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result ?? {})));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return { send, close: () => ws.close() };
}

/**
 * Helpers the shots run in the page: click a button by its text, pick an option in a labelled select (as React sees
 * a change), press a key, and wait for something to appear.
 */
const HELPERS = `
window.__shot = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async until(find, ms = 5000) {
    for (let t = 0; t < ms; t += 100) {
      const found = find();
      if (found) return found;
      await this.sleep(100);
    }
    throw new Error("Never appeared: " + find);
  },
  button: (text) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(text)),
  async click(text) {
    (await this.until(() => this.button(text))).click();
    await this.sleep(300);
  },
  async select(label, value) {
    const el = await this.until(() => document.querySelector('select[aria-label="' + label + '"]'));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await this.sleep(300);
  },
  async key(key) {
    // On the document, so listeners there and on the window both hear it.
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await this.sleep(400);
  },
  // Checks only: what the demo shows is then exactly what Alden finds in the recorded PR, nothing invented. The demo
  // has no clone to find callers in, so callers are left out rather than showing the "no clone" notice.
  async brief() {
    const model = await this.until(() => this.button("Ask the model"));
    if (model.getAttribute("aria-pressed") === "true") model.click();
    await this.sleep(100);
    document.querySelector('[role="switch"][aria-checked="true"]')?.click();
    await this.sleep(100);
    await this.click("Brief me");
    await this.until(() => document.querySelector('[role="tablist"][aria-label="Briefing or diff"]'), 8000);
    await this.sleep(500);
  },
};
`;

const children: ChildProcess[] = [];
const profile = mkdtempSync(join(tmpdir(), "alden-shots-chrome-"));
const home = mkdtempSync(join(tmpdir(), "alden-shots-home-"));
try {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(home, "config.toml"), RANKING);
  for (const { port, env } of Object.values(DEMOS)) {
    children.push(
      spawn("pnpm", ["-s", "ui:demo", "--port", String(port)], {
        cwd: ROOT,
        stdio: "ignore",
        env: { ...process.env, ...env, ALDEN_HOME: home },
      }),
    );
  }
  for (const { port } of Object.values(DEMOS)) {
    await waitFor(`http://127.0.0.1:${port}/`);
    // Answer the usage-stats question so its card isn't in the shots.
    await fetch(`http://127.0.0.1:${port}/api/telemetry`, {
      method: "PUT",
      headers: { "X-Alden-Token": "demo", "Content-Type": "application/json" },
      body: JSON.stringify({ on: false }),
    });
  }
  children.push(
    spawn(
      CHROME,
      [
        "--headless=new",
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-scrollbars",
        "about:blank",
      ],
      { stdio: "ignore" },
    ),
  );
  const targets = (await (await waitFor(`http://127.0.0.1:${CDP_PORT}/json`)).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("Chrome has no page");
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const evaluate = async (expression: string) => {
    const result = (await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${HELPERS}; const s = window.__shot; ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })) as { exceptionDetails?: { exception?: { description?: string } } };
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? expression);
  };

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
    // Each shot starts from a clean window: no remembered filters, tab or drawer state.
    await cdp.send("Page.navigate", { url: "about:blank" });
    await cdp.send("Storage.clearDataForOrigin", { origin: `http://127.0.0.1:${port}`, storageTypes: "all" });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}${options.path}#t=demo` });
    await sleep(1_500);
    if (options.brief) await evaluate("await s.brief();");
    if (options.steps) await evaluate(options.steps);
    await evaluate("await document.fonts.ready; document.activeElement?.blur?.();");
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
    steps: `await s.key("s"); await s.select("Repository", "django/django"); await s.select("CI", "passing");`,
  });
  await shot("diff-dark", {
    path: "/pr/cli/cli/10513",
    brief: true,
    steps: `await s.key("s"); await s.key("d"); await s.sleep(800); await s.key("]");`,
  });
  await shot("guided-dark", {
    path: "/pr/cli/cli/10513",
    brief: true,
    steps: `await s.key("s"); await s.click("Start guided review"); await s.sleep(800);`,
  });
  await shot("comments-dark", { path: "/pr/cli/cli/10513", height: 1100, brief: true, steps: `await s.key("[");` });
  await shot("comments-light", {
    path: "/pr/cli/cli/10513",
    height: 1100,
    dark: false,
    brief: true,
    steps: `await s.key("[");`,
  });
  await shot("ranking-dark", {
    path: "/settings",
    width: 1100,
    height: 1100,
    steps: `(await s.until(() => document.querySelector("#ranking-title"))).scrollIntoView({ block: "start" }); window.scrollBy(0, -24);`,
  });
  await shot("model-setup-dark", {
    path: "/pr/django/django/19057",
    demo: "noModel",
    steps: `await s.click("Set up a model"); await s.sleep(600);`,
  });
  // A briefing the app prepared while you were away, as the window shows it (callers off: the demo has no clones).
  await shot("desktop-ready-dark", {
    path: "/pr/django/django/19057",
    demo: "desktop",
    width: 1280,
    height: 840,
    steps: `await s.key("s"); document.querySelector('[role="switch"][aria-checked="true"]')?.click();`,
  });
  await shot("desktop-settings-dark", {
    path: "/settings",
    demo: "desktop",
    width: 1280,
    height: 840,
    steps: `[...document.querySelectorAll("h2")].find((h) => h.textContent === "Command line tool")?.scrollIntoView({ block: "start" }); window.scrollBy(0, -24);`,
  });
  cdp.close();
} finally {
  for (const child of children) child.kill();
  // The demos run under pnpm; make sure their servers go too.
  for (const { port } of Object.values(DEMOS)) {
    spawn("sh", ["-c", `lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill 2>/dev/null`]);
  }
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
