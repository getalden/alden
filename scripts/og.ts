/**
 * The social card, site/src/assets/og.png (1200x630): `pnpm og`.
 *
 * Renders scripts/og.html in headless Chrome, with the site's Geist font and a real screenshot of the app
 * (site/src/assets/screens/briefing-dark.png, so run `pnpm screenshots` first when the UI changes) inlined as data
 * URLs. Offline. The card is also GitHub's social preview for the repo, which is uploaded by hand in its settings.
 * `--out <file>` writes it somewhere else, to look without replacing the site's.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, launchChrome, sleep } from "./chrome.js";

const ROOT = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const out = args.includes("--out") ? (args[args.indexOf("--out") + 1] as string) : join(ROOT, "site/src/assets/og.png");
const dataUrl = (path: string, type: string) => `data:${type};base64,${readFileSync(path).toString("base64")}`;

const html = readFileSync(join(import.meta.dirname, "og.html"), "utf8")
  .replace("{{GEIST}}", dataUrl(join(ROOT, "packages/ui/src/fonts/Geist-Variable.woff2"), "font/woff2"))
  .replace("{{SCREEN}}", dataUrl(join(ROOT, "site/src/assets/screens/briefing-dark.png"), "image/png"));

const chrome = await launchChrome(9341);
try {
  const { cdp } = chrome;
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 630,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const { frameTree } = (await cdp.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
  await cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
  await evaluate(cdp, "await document.fonts.ready; await Promise.all([...document.images].map((i) => i.decode()));");
  await sleep(200);
  const { data } = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`wrote ${out}`);
  cdp.close();
} finally {
  await chrome.stop();
}
