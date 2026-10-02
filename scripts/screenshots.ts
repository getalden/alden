/**
 * Screenshots of the UI over the demo data, for the site, the README and marketing: `pnpm screenshots`.
 *
 * Starts `pnpm ui:demo` on its own port and a headless Chrome with a throwaway profile (never yours), drives it over
 * the DevTools protocol, and writes PNGs to site/src/assets/screens. Build the UI first.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "site/src/assets/screens");
const PORT = 4329;
const CDP_PORT = 9339;
const CHROME =
  process.env.CHROME ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url: string, tries = 60): Promise<Response> {
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

const children: ChildProcess[] = [];
const profile = mkdtempSync(join(tmpdir(), "alden-shots-chrome-"));
try {
  mkdirSync(OUT, { recursive: true });
  children.push(spawn("pnpm", ["-s", "ui:demo", "--port", String(PORT)], { cwd: ROOT, stdio: "ignore" }));
  await waitFor(`http://127.0.0.1:${PORT}/`);
  // Answer the usage-stats question so its card isn't in the shots.
  await fetch(`http://127.0.0.1:${PORT}/api/telemetry`, {
    method: "PUT",
    headers: { "X-Alden-Token": "demo", "Content-Type": "application/json" },
    body: JSON.stringify({ on: false }),
  });
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
  const evaluate = (expression: string) =>
    cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

  const shot = async (
    name: string,
    options: { path: string; width: number; height: number; dark: boolean; brief?: boolean; scale?: number },
  ) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.scale ?? 2,
      mobile: false,
    });
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: options.dark ? "dark" : "light" }],
    });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}${options.path}#t=demo` });
    await sleep(1_500);
    if (options.brief) {
      // Checks only: what the demo shows is then exactly what Alden finds in the recorded PR, nothing invented.
      await evaluate(
        `[...document.querySelectorAll("button")].find((b) => b.textContent === "Ask the model" && b.getAttribute("aria-pressed") === "true")?.click()`,
      );
      // The demo has no clone to find callers in; leave that out rather than show the "no clone" notice.
      await evaluate(`document.querySelector('[role="switch"][aria-checked="true"]')?.click()`);
      await evaluate(`[...document.querySelectorAll("button")].find((b) => /Brief me/.test(b.textContent))?.click()`);
      await sleep(3_500);
    }
    await evaluate("document.fonts.ready.then(() => true)");
    const { data } = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`wrote ${name}.png`);
  };

  await shot("briefing-dark", { path: "/pr/django/django/19057", width: 1440, height: 900, dark: true, brief: true });
  await shot("briefing-light", { path: "/pr/django/django/19057", width: 1440, height: 900, dark: false, brief: true });
  await shot("queue-dark", { path: "/", width: 1440, height: 900, dark: true });
  await shot("memory-dark", { path: "/memory", width: 1440, height: 900, dark: true });
  await shot("memory-light", { path: "/memory", width: 1440, height: 900, dark: false });
  await shot("stats-dark", { path: "/stats", width: 1440, height: 900, dark: true });
  await shot("narrow-dark", { path: "/pr/vercel/next.js/99367", width: 420, height: 860, dark: true, brief: true });
  cdp.close();
} finally {
  for (const child of children) child.kill();
  // The demo runs under pnpm; make sure its server goes too.
  spawn("sh", ["-c", `lsof -tiTCP:${PORT} -sTCP:LISTEN | xargs kill 2>/dev/null`]);
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
