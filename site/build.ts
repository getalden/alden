/**
 * Builds getalden.dev into site/dist: `pnpm site:build`.
 *
 * The landing page is static (site/src). The docs are the repo's own docs/*.md, rendered into the site's look, in the
 * order docs/README.md lists them, so the site and the repo never disagree. A doc shows a screenshot with a relative
 * link that works on GitHub too, `![alt](../site/src/assets/screens/x.png)`, served here as /assets/screens/x.png.
 * /benchmarks/ and /cloud/ are
 * src/benchmarks.html and src/cloud.html in the same frame. Every page loads site.js (page view counts and copy
 * buttons). Cloudflare Pages serves site/dist as is (`pnpm site:deploy`), with the security headers in _headers.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Marked } from "marked";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(import.meta.dirname, "src");
const OUT = join(import.meta.dirname, "dist");
const DOCS = join(ROOT, "docs");
const REPO = "https://github.com/getalden/alden";
const GITHUB = `${REPO}/blob/main`;
const DISCORD = "https://discord.gg/ZtXFX7sxTu";

/**
 * The open-source switch, for launch day: `ALDEN_OPEN_SOURCE=1 pnpm site:build` says Alden is open source and links its
 * repo from the home page and every page's header and footer. Without it the site says "open source after the beta",
 * exactly as today. Each swap is exact text in src/index.html, and the build stops if one is missing, with or without
 * the flag, so a copy change can't quietly turn the switch into a no-op.
 */
const OPEN_SOURCE = process.env.ALDEN_OPEN_SOURCE === "1";
// In the header it gives way on a phone, where the footer still has it.
const GITHUB_LINK = (label: "nav" | "footer") =>
  `<a href="${REPO}" rel="noopener" data-label="${label}"${label === "nav" ? ' class="wide-only"' : ""}>GitHub</a>`;
const HOME_SWAPS: [today: string, openSource: string][] = [
  [
    "open beta · open source after the beta · macOS, Linux and Windows",
    "open beta · open source, Apache-2.0 · macOS, Linux and Windows",
  ],
  [
    "<dd>Open source when the beta ends. The single-developer app stays free.</dd>",
    `<dd>Open source under Apache-2.0: <a href="${REPO}" rel="noopener">the code is on GitHub</a>. The single-developer app stays free.</dd>`,
  ],
  [
    `<a href="${DISCORD}" rel="noopener">Discord</a>`,
    `${GITHUB_LINK("nav")}\n          <a href="${DISCORD}" rel="noopener">Discord</a>`,
  ],
  [
    `><a href="${DISCORD}" rel="noopener" data-label="footer">Discord</a`,
    `>${GITHUB_LINK("footer").slice(0, -1)}\n        ><a href="${DISCORD}" rel="noopener" data-label="footer">Discord</a`,
  ],
];

rmSync(OUT, { recursive: true, force: true });
// benchmarks.html and cloud.html are the bodies of /benchmarks/ and /cloud/, wrapped in the page below.
const BODIES = ["benchmarks.html", "cloud.html"];
cpSync(SRC, OUT, { recursive: true, filter: (path) => !BODIES.some((body) => path.endsWith(body)) });
{
  const file = join(OUT, "index.html");
  let home = readFileSync(file, "utf8");
  for (const [today, openSource] of HOME_SWAPS) {
    if (!home.includes(today)) {
      throw new Error(
        `The open-source switch looks for "${today}" in src/index.html: update HOME_SWAPS in site/build.ts.`,
      );
    }
    if (OPEN_SOURCE) home = home.replace(today, openSource);
  }
  writeFileSync(file, home);
}
mkdirSync(join(OUT, "assets/fonts"), { recursive: true });
for (const font of ["Geist-Variable.woff2", "GeistMono-Variable.woff2", "OFL.txt"]) {
  cpSync(join(ROOT, "packages/ui/src/fonts", font), join(OUT, "assets/fonts", font));
}

// --- Docs ---------------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slugOf = (file: string) => (file === "README.md" ? "" : file.replace(/\.md$/, ""));
const hrefOf = (file: string) => (file === "README.md" ? "/docs/" : `/docs/${slugOf(file)}/`);
const ASSETS = "../site/src/assets/";

/** docs/README.md's lists, in order: the sidebar. */
const index = readFileSync(join(DOCS, "README.md"), "utf8");
const sections: { title: string; pages: { file: string; title: string }[] }[] = [];
for (const line of index.split("\n")) {
  const heading = /^## (.+)$/.exec(line);
  if (heading?.[1]) sections.push({ title: heading[1], pages: [] });
  const link = /^- \[([^\]]+)\]\(([\w-]+\.md)\)/.exec(line);
  if (link?.[1] && link[2]) sections.at(-1)?.pages.push({ title: link[1], file: link[2] });
}

const marked = new Marked({
  gfm: true,
  renderer: {
    // Links between docs go to their pages; links into the repo go to GitHub.
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      let target = href;
      const doc = /^([\w-]+\.md)(#.*)?$/.exec(href);
      if (doc?.[1]) target = `${hrefOf(doc[1])}${doc[2] ?? ""}`;
      else if (href.startsWith("../")) target = `${GITHUB}/${href.slice(3)}`;
      const external = /^https?:/.test(target) && !target.startsWith("https://getalden.dev");
      return `<a href="${esc(target)}"${title ? ` title="${esc(title)}"` : ""}${external ? ' rel="noopener"' : ""}>${text}</a>`;
    },
    // Images are the site's own assets, linked from docs/ as ../site/src/assets/…; anything else would be a broken
    // image on one of the two, so the build stops.
    image({ href, title, text }) {
      if (!href.startsWith(ASSETS) || !existsSync(join(SRC, "assets", href.slice(ASSETS.length)))) {
        throw new Error(
          `A doc shows ${href}: link images as ${ASSETS}<file>, and run \`pnpm screenshots\` for screens.`,
        );
      }
      const src = `/assets/${href.slice(ASSETS.length)}`;
      return `<a class="shot" href="${esc(src)}"><img src="${esc(src)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ""} loading="lazy" /></a>`;
    },
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = text
        .replace(/<[^>]+>/g, "")
        .replace(/&[#\w]+;/g, "")
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
      return `<h${depth} id="${id}">${text}</h${depth}>\n`;
    },
  },
});

const header = `<header class="top">
  <a class="brand" href="/" aria-label="Alden home">
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect x=".5" y=".5" width="31" height="31" rx="8" fill="#101B20" stroke="#263c44"/><path d="M8 24 L16 8 L24 24" fill="none" stroke="#14B8A6" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="24" r="2" fill="#5EEAD4"/><circle cx="16" cy="8" r="2" fill="#5EEAD4"/><circle cx="24" cy="24" r="2" fill="#5EEAD4"/><circle cx="16" cy="19" r="2.4" fill="#F0FDFA"/></svg>
    <span>alden</span>
  </a>
  <nav><a href="/docs/">Docs</a><a href="/benchmarks/">Benchmarks</a>${OPEN_SOURCE ? GITHUB_LINK("nav") : ""}<a href="${DISCORD}" rel="noopener">Discord</a><a class="btn small" href="/docs/getting-started/" data-track="install" data-label="nav">Install</a></nav>
</header>`;

function page(title: string, description: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta name="theme-color" content="#081014" />
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/site.css" />
</head>
<body>
${header}
${body}
<footer class="foot"><span class="word">alden</span><span>This site counts page views, no cookies.</span><span class="links"><a href="/docs/">Docs</a><a href="/benchmarks/">Benchmarks</a><a href="/cloud/">Alden Cloud</a>${OPEN_SOURCE ? GITHUB_LINK("footer") : ""}<a href="${DISCORD}" rel="noopener" data-label="footer">Discord</a><a href="mailto:beta@getalden.dev" data-track="contact" data-label="footer">beta@getalden.dev</a><a href="/docs/privacy/#this-website">Privacy</a><span>getalden.dev</span></span></footer>
<script src="/site.js" defer></script>
</body>
</html>
`;
}

const files = readdirSync(DOCS).filter((f) => f.endsWith(".md"));
for (const file of files) {
  const markdown = readFileSync(join(DOCS, file), "utf8");
  const title = /^# (.+)$/m.exec(markdown)?.[1] ?? "Alden docs";
  const description =
    markdown
      .split("\n")
      .find((l) => l.trim() && !l.startsWith("#") && !l.startsWith(">"))
      ?.replace(/[`*[\]]/g, "")
      .replace(/\(([^)]+)\)/g, "")
      .slice(0, 160) ?? "Alden documentation";
  const nav = sections
    .map(
      (s) =>
        `<span class="label">${esc(s.title)}</span>${s.pages
          .map((p) => `<a href="${hrefOf(p.file)}"${p.file === file ? ' aria-current="page"' : ""}>${esc(p.title)}</a>`)
          .join("")}`,
    )
    .join("");
  const body = `<main class="docs">
<nav class="docs-nav" aria-label="Docs"><a href="/docs/"${file === "README.md" ? ' aria-current="page"' : ""}>Overview</a>${nav}</nav>
<article class="prose">${marked.parse(markdown, { async: false })}</article>
</main>`;
  const dir = join(OUT, "docs", slugOf(file));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), page(`${title} · Alden docs`, description, body));
}

writeFileSync(
  join(OUT, "404.html"),
  page(
    "Not found · Alden",
    "That page doesn't exist.",
    `<main class="docs"><article class="prose"><h1>Not here</h1><p>That page doesn't exist. Try <a href="/docs/">the docs</a> or <a href="/">the home page</a>.</p></article></main>`,
  ),
);

// --- Benchmarks ---------------------------------------------------------------------------------------------------

mkdirSync(join(OUT, "benchmarks"), { recursive: true });
writeFileSync(
  join(OUT, "benchmarks", "index.html"),
  page(
    "Benchmarks · Alden",
    "How Alden did on 150 test PRs in four repos and on recorded public PRs that later broke: what it got right, what it missed, how fast, what it cost, and how to run it again.",
    readFileSync(join(SRC, "benchmarks.html"), "utf8"),
  ),
);

// --- Alden Cloud --------------------------------------------------------------------------------------------------

mkdirSync(join(OUT, "cloud"), { recursive: true });
writeFileSync(
  join(OUT, "cloud", "index.html"),
  page(
    "Alden Cloud (beta) · Alden",
    "Alden Cloud, planned: sign in with GitHub and Alden's model just works, with no API key. Not available yet; join the waitlist.",
    readFileSync(join(SRC, "cloud.html"), "utf8"),
  ),
);

if (!existsSync(join(OUT, "assets/screens/briefing-dark.png"))) {
  throw new Error("site/src/assets/screens is missing its screenshots. Run `pnpm screenshots`.");
}
console.log(
  `Built ${files.length} docs pages, the benchmarks, Alden Cloud and the home page into site/dist${OPEN_SOURCE ? ", saying Alden is open source (ALDEN_OPEN_SOURCE=1)" : ""}.`,
);
