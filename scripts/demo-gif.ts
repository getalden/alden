/**
 * The README's demo GIF, site/src/assets/demo.gif (served at https://getalden.dev/assets/demo.gif): `pnpm demo:gif`.
 *
 * Over the demo data (`pnpm ui:demo` with a throwaway ALDEN_HOME, checks only, nothing sent or asked of a model), a
 * headless Chrome plays one short review: the queue, open a PR, its Brief, Walk through a place or two, the Comments
 * drawer, the send dialog and Back. Frames are timed screenshots, sampled at FPS; gifenc (pure JS) encodes them with
 * one palette for the whole GIF, and each frame after the first carries only the pixels that changed, so it stays
 * small. No ffmpeg or ImageMagick needed. Build the UI first.
 *
 * `--out <file>` writes it somewhere else; `--frames <dir>` also saves each distinct frame as a PNG, to look at.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import gifenc from "gifenc";
import { type Cdp, connect, evaluate, launchChrome, sleep } from "./chrome.js";
import { HELPERS, ROOT, startDemos } from "./demo-pages.js";

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const { applyPalette, GIFEncoder, quantize } = gifenc;
const OUT = option("--out") ?? join(ROOT, "site/src/assets/demo.gif");
const FRAMES = option("--frames");
const PORT = 4339;
const CDP_PORT = 9343;
/** The page is laid out at VIEW and recorded at SCALE of it: 960x600. */
const VIEW = { width: 1280, height: 800 };
const SCALE = 0.75;
const WIDTH = VIEW.width * SCALE;
const HEIGHT = VIEW.height * SCALE;
const FPS = 11;

/**
 * The review, as it plays: each beat waits so the eye can follow. The row and the drawer's buttons are clicked; the reading steps and
 * the drawer are the UI's own keys (g, n, s).
 */
const STORY = `
  const row = await s.until(() => document.querySelector('a[href="/pr/cli/cli/10513"]'));
  await s.sleep(1300);
  row.click();
  await s.until(() => document.querySelector('[role="tablist"][aria-label="Reading step"]'), 8000);
  await s.sleep(2200);
  await s.key("g");
  await s.sleep(1700);
  await s.key("n");
  await s.sleep(1500);
  await s.key("s");
  await s.sleep(1900);
  await s.click("Review and send");
  await s.until(() => document.querySelector(".send-dialog"));
  await s.sleep(2400);
  // The dialog's Back, not the walk-through's "Back to the brief" behind it.
  [...document.querySelectorAll(".send-dialog button")].find((b) => b.textContent.trim() === "Back").click();
  await s.sleep(1200);
`;

const home = mkdtempSync(join(tmpdir(), "alden-gif-home-"));
const demos = await startDemos([{ port: PORT, env: {} }], home);
const chrome = await launchChrome(CDP_PORT).catch(async (error: unknown) => {
  await demos.stop();
  throw error;
});
try {
  const { cdp } = chrome;
  const run = (expression: string) => evaluate(cdp, `${HELPERS}; const s = window.__shot; ${expression}`);
  await cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEW, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });

  // Before recording: brief the PR with checks only (callers off: the demo has no clone), with the drawer closed and
  // the reading steps at Brief, then back to the queue. The briefing is kept, so opening the PR shows it at once.
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/pr/cli/cli/10513#t=demo` });
  await sleep(1_500);
  await run(`await s.brief(); await s.key("s");
    (await s.until(() => [...document.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/" && a.textContent.trim().startsWith("Queue")))).click();
    await s.sleep(800); await document.fonts.ready; document.activeElement?.blur?.();`);
  await sleep(500);

  // Record: the story plays in the page while screenshots are taken as fast as Chrome gives them.
  const shots: { at: number; png: string }[] = [];
  let playing = true;
  const started = Date.now();
  const story = run(STORY).finally(() => {
    playing = false;
  });
  while (playing) {
    const { data } = (await cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, ...VIEW, scale: SCALE },
    })) as { data: string };
    shots.push({ at: Date.now() - started, png: data });
  }
  await story;
  const duration = Date.now() - started;

  // Sample at FPS: each tick shows the latest screenshot taken by then; a frame that repeats the last one lengthens it.
  const frames: { png: string; ms: number }[] = [];
  const tick = 1000 / FPS;
  for (let t = 0, i = 0; t < duration; t += tick) {
    while (i + 1 < shots.length && (shots[i + 1]?.at ?? Infinity) <= t) i++;
    const png = shots[i]?.png as string;
    const last = frames.at(-1);
    if (last && last.png === png) last.ms += tick;
    else frames.push({ png, ms: tick });
  }

  // Decode in a second tab: Chrome turns each PNG into RGBA, which Node then encodes.
  const decoder = await openTab(CDP_PORT);
  const pixels: Uint8Array[] = [];
  for (const [n, frame] of frames.entries()) {
    pixels.push(await rgba(decoder, frame.png));
    if (FRAMES) {
      mkdirSync(FRAMES, { recursive: true });
      writeFileSync(join(FRAMES, `${String(n).padStart(3, "0")}.png`), Buffer.from(frame.png, "base64"));
    }
  }
  decoder.close();

  // One palette for every frame, from a sample of them, with its last entry kept for "unchanged" (transparent).
  const sample = pixels.filter((_, i) => i % Math.max(1, Math.floor(pixels.length / 12)) === 0);
  const joined = new Uint8Array(sample.reduce((n, p) => n + p.length, 0));
  sample.reduce((offset, p) => {
    joined.set(p, offset);
    return offset + p.length;
  }, 0);
  const palette = quantize(joined, 255);
  const clear = palette.length;
  palette.push([255, 0, 255]);

  const gif = GIFEncoder();
  let previous: Uint8Array | undefined;
  for (const [n, frame] of frames.entries()) {
    const index = applyPalette(pixels[n] as Uint8Array, palette);
    const shown = index.slice();
    if (previous) for (let p = 0; p < index.length; p++) if (index[p] === previous[p]) index[p] = clear;
    gif.writeFrame(index, WIDTH, HEIGHT, {
      ...(n === 0 ? { palette, repeat: 0 } : { transparent: true, transparentIndex: clear }),
      delay: Math.round(frame.ms),
      dispose: 1,
    });
    previous = shown;
  }
  gif.finish();
  writeFileSync(OUT, gif.bytes());
  const seconds = frames.reduce((s, f) => s + f.ms, 0) / 1000;
  const mb = statSync(OUT).size / 1_000_000;
  console.log(
    `wrote ${OUT}: ${WIDTH}x${HEIGHT}, ${seconds.toFixed(1)} s at ${FPS} fps (${frames.length} distinct frames from ${shots.length} screenshots), ${mb.toFixed(2)} MB`,
  );
  cdp.close();
} finally {
  await chrome.stop();
  await demos.stop();
  rmSync(home, { recursive: true, force: true });
}

/** Another tab in the same Chrome, for decoding. */
async function openTab(port: number): Promise<Cdp> {
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()) as {
    webSocketDebuggerUrl: string;
  };
  const tab = await connect(target.webSocketDebuggerUrl);
  await tab.send("Runtime.enable");
  return tab;
}

/** A PNG's pixels, as RGBA, decoded by Chrome. */
async function rgba(tab: Cdp, png: string): Promise<Uint8Array> {
  const base64 = await evaluate<string>(
    tab,
    `const blob = await (await fetch("data:image/png;base64,${png}")).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let text = "";
    for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    return btoa(text);`,
  );
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.length !== WIDTH * HEIGHT * 4)
    throw new Error(`A frame decoded to ${bytes.length} bytes, not ${WIDTH}x${HEIGHT}.`);
  return bytes;
}
