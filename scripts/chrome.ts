/**
 * Headless Chrome over the DevTools protocol, for the scripts that make the site's images: `pnpm screenshots`,
 * `pnpm og` and `pnpm demo:gif`. A throwaway profile each time; nothing of yours is read. Set CHROME to use another
 * Chrome or Chromium.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME =
  process.env.CHROME ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetches `url` until it answers 2xx. */
export async function waitFor(url: string, tries = 80): Promise<Response> {
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

export type Cdp = Awaited<ReturnType<typeof connect>>;

/** A minimal DevTools protocol client: send a command, await its reply, and hear events. */
export async function connect(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map<number, (value: { result?: Record<string, unknown>; error?: unknown }) => void>();
  const listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: unknown;
    };
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method) for (const listener of listeners.get(msg.method) ?? []) listener(msg.params ?? {});
  };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const n = ++id;
      pending.set(n, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result ?? {})));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const on = (method: string, listener: (params: Record<string, unknown>) => void) => {
    listeners.set(method, [...(listeners.get(method) ?? []), listener]);
  };
  return { send, on, close: () => ws.close() };
}

/** Starts headless Chrome on `port` with a throwaway profile; `stop` ends it and removes the profile. */
export async function launchChrome(
  port: number,
): Promise<{ cdp: Cdp; process: ChildProcess; stop: () => Promise<void> }> {
  const profile = mkdtempSync(join(tmpdir(), "alden-chrome-"));
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const stop = async () => {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await Promise.race([exited, sleep(2_000)]);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    const targets = (await (await waitFor(`http://127.0.0.1:${port}/json`)).json()) as {
      type: string;
      webSocketDebuggerUrl: string;
    }[];
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome has no page");
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    return { cdp, process: child, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Runs `expression` (an async function body) in the page and returns its value; throws what the page threw. */
export async function evaluate<T = unknown>(cdp: Cdp, expression: string): Promise<T> {
  const result = (await cdp.send("Runtime.evaluate", {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } } };
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? expression);
  return result.result?.value as T;
}
