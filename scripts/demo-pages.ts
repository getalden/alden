/**
 * The demo UI for the scripts that picture it (`pnpm screenshots`, `pnpm demo:gif`): `pnpm ui:demo` servers on their
 * own ports with a throwaway ALDEN_HOME (never yours), and the helpers those scripts run in the page. No network: the
 * demo is offline, and nothing in it calls a model or GitHub.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { sleep, waitFor } from "./chrome.js";

export const ROOT = join(import.meta.dirname, "..");

/** Starts `pnpm ui:demo` on each port with its env, all over `home`; resolves when every one answers. */
export async function startDemos(demos: { port: number; env: Record<string, string> }[], home: string) {
  const children: ChildProcess[] = demos.map(({ port, env }) =>
    spawn("pnpm", ["-s", "ui:demo", "--port", String(port)], {
      cwd: ROOT,
      stdio: "ignore",
      env: { ...process.env, ...env, ALDEN_HOME: home },
    }),
  );
  const stop = async () => {
    for (const child of children) child.kill();
    // The demos run under pnpm; make sure their servers go too.
    for (const { port } of demos) spawn("sh", ["-c", `lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill 2>/dev/null`]);
    await sleep(300);
  };
  try {
    for (const { port } of demos) {
      await waitFor(`http://127.0.0.1:${port}/`);
      // Answer the usage-stats question so its card isn't in the pictures.
      await fetch(`http://127.0.0.1:${port}/api/telemetry`, {
        method: "PUT",
        headers: { "X-Alden-Token": "demo", "Content-Type": "application/json" },
        body: JSON.stringify({ on: false }),
      });
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { stop };
}

/**
 * Helpers run in the page, as `s`: click a button by its text, pick an option in a labelled select (as React sees
 * a change), type into an input, press a key, wait for something to appear, and brief the PR with checks only.
 */
export const HELPERS = `
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
  async type(selector, text) {
    const el = await this.until(() => document.querySelector(selector));
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await this.sleep(100);
    return el;
  },
  async key(key) {
    // On the document, so listeners there and on the window both hear it.
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await this.sleep(400);
  },
  // Checks only: what the demo shows is then exactly what Alden finds in the recorded PR, nothing invented. The demo
  // has no clone to find callers in, so callers are left out rather than showing the "no clone" notice. Both are in
  // the Tune popover, from the model line.
  async brief() {
    (await this.until(() => document.querySelector(".model-line"))).click();
    await this.sleep(200);
    (await this.until(() => document.querySelector('.tune-popover [aria-label^="Model:"]'))).click();
    await this.sleep(200);
    (await this.until(() => [...document.querySelectorAll('[role="menuitemradio"]')].find((b) => b.textContent.startsWith("Checks only")))).click();
    await this.sleep(100);
    document.querySelector('.tune-popover [role="switch"][aria-checked="true"]')?.click();
    await this.sleep(100);
    document.querySelector(".tune-popover")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await this.sleep(200);
    await this.click("Brief me");
    await this.until(() => document.querySelector('[role="tablist"][aria-label="Reading step"]'), 8000);
    await this.sleep(500);
  },
};
`;
