/**
 * Builds getalden.dev into site/dist: `pnpm site:build`.
 *
 * The landing page is static (site/src). The docs are the repo's own docs/*.md, rendered into the "Alden Docs v3"
 * frame from Claude Design, in the groups and order docs/README.md lists under "All pages", so the site and the repo
 * never disagree. A doc shows a screenshot with a relative link that works on GitHub too,
 * `![alt](../site/src/assets/screens/x.png)`, served here as /assets/screens/x.png. /benchmarks/ and /cloud/ are
 * src/benchmarks.html and src/cloud.html in the same frame. Every page loads site.js (page view counts and copy
 * buttons); framed pages also load theme.js (light, dark or the system's) and docs.js (search, the sidebar drawer,
 * "On this page" and Copy page). Search runs on the visitor's device over /docs/search.json, built here. Cloudflare
 * Pages serves site/dist as is (`pnpm site:deploy`), with the security headers in _headers.
 */
import { execFileSync } from "node:child_process";
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
 * repo from the home page and every page's header and footer, and each doc gets "Edit on GitHub". Without it the site
 * says "open source after the beta", exactly as today. Each swap is exact text in src/index.html, and the build stops
 * if one is missing, with or without the flag, so a copy change can't quietly turn the switch into a no-op.
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

// --- The frame: header, footer and search, shared by the docs, /benchmarks/ and /cloud/ ---------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ICON = {
  search: `<svg class="icon" width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><circle cx="6" cy="6" r="4.6"/><path d="M9.5 9.5L13 13"/></svg>`,
  menu: `<svg class="icon" width="14" height="10" viewBox="0 0 14 10" aria-hidden="true"><path d="M0 1h14M0 5h14M0 9h14"/></svg>`,
  chevron: `<svg class="icon chev" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5L6.5 5 3 8.5"/></svg>`,
  copy: `<svg class="icon" width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><rect x="4.5" y="4.5" width="8" height="8" rx="1.5"/><path d="M9.5 2.6V2.5A1 1 0 0 0 8.5 1.5h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.1"/></svg>`,
};

type Tab = "docs" | "benchmarks" | "cloud" | null;

function header(tab: Tab, withMenu: boolean): string {
  const tabLink = (href: string, label: string, name: Tab) =>
    `<a href="${href}"${tab === name ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<header class="dtop">
  ${withMenu ? `<button class="menu-btn" type="button" aria-label="Open navigation" aria-controls="docs-side" aria-expanded="false">${ICON.menu}</button>` : ""}
  <a class="dbrand" href="/" aria-label="Alden home">
    <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true"><rect class="m-bg" x=".75" y=".75" width="30.5" height="30.5" rx="8"/><path class="m-a" d="M9 23.5 L16 8.5 L23 23.5"/><path class="m-in" d="M9 23.5 L16 19 L23 23.5 M16 8.5 V19"/><circle class="m-dot" cx="9" cy="23.5" r="1.9"/><circle class="m-dot" cx="16" cy="8.5" r="1.9"/><circle class="m-dot" cx="23" cy="23.5" r="1.9"/><circle class="m-core" cx="16" cy="19" r="2.2"/></svg>
    <span>alden</span>
  </a>
  <nav class="tabs" aria-label="Site">${tabLink("/docs/", "Docs", "docs")}${tabLink("/benchmarks/", "Benchmarks", "benchmarks")}${tabLink("/cloud/", "Alden Cloud", "cloud")}</nav>
  <button class="search-btn" type="button" aria-haspopup="dialog">${ICON.search}<span>Search docs…</span><kbd>⌘K</kbd></button>
  <div class="dtop-end">${OPEN_SOURCE ? GITHUB_LINK("nav") : ""}<a class="dbtn" href="/docs/getting-started/" data-track="install" data-label="nav">Install</a></div>
</header>`;
}

const footer = `<footer class="dfoot">
  <div class="dfoot-in">
    <span class="word">alden</span>
    <span class="links"><a href="/docs/">Docs</a><a href="/benchmarks/">Benchmarks</a><a href="/cloud/">Alden Cloud</a>${OPEN_SOURCE ? GITHUB_LINK("footer") : ""}<a href="${DISCORD}" rel="noopener" data-label="footer">Discord</a><a href="mailto:beta@getalden.dev" data-track="contact" data-label="footer">beta@getalden.dev</a><a href="/docs/privacy/#this-website">Privacy</a></span>
    <span class="theme" role="group" aria-label="Theme"><button type="button" data-theme-set="system" aria-pressed="true">System</button><button type="button" data-theme-set="light" aria-pressed="false">Light</button><button type="button" data-theme-set="dark" aria-pressed="false">Dark</button></span>
    <span class="note">This site counts page views, no cookies.</span>
  </div>
</footer>`;

const searchDialog = `<div class="search" hidden>
  <div class="search-box" role="dialog" aria-modal="true" aria-label="Search docs">
    <div class="search-head">${ICON.search}<input type="search" placeholder="Search docs" autocomplete="off" spellcheck="false" aria-label="Search docs" aria-controls="search-results" /><kbd>esc</kbd></div>
    <div class="search-results" id="search-results" role="listbox" aria-label="Results"></div>
    <div class="search-foot"><span>↑↓ to move</span><span>↵ to open</span><span class="right">Searched on this device</span></div>
  </div>
</div>`;

function page(title: string, description: string, body: string, tab: Tab, withMenu = false): string {
  return `<!doctype html>
<html lang="en" class="dframe">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta name="theme-color" content="#121413" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#f6f5f1" media="(prefers-color-scheme: light)" />
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml" />
<link rel="stylesheet" href="/site.css" />
<link rel="stylesheet" href="/docs.css" />
<script src="/theme.js"></script>
</head>
<body>
${header(tab, withMenu)}
${body}
${footer}
${searchDialog}
<script src="/site.js" defer></script>
<script src="/docs.js" defer></script>
</body>
</html>
`;
}

// --- Docs ---------------------------------------------------------------------------------------------------------

const slugOf = (file: string) => (file === "README.md" ? "" : file.replace(/\.md$/, ""));
const hrefOf = (file: string) => (file === "README.md" ? "/docs/" : `/docs/${slugOf(file)}/`);
const ASSETS = "../site/src/assets/";
const idOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&[#\w]+;/g, "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
const plain = (markdown: string) =>
  markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * docs/README.md is the docs home. Its "All pages" section is the sidebar: each ### is a group and its links are the
 * pages, in order. On the site the sidebar shows them, so the home page leaves that section out.
 */
const index = readFileSync(join(DOCS, "README.md"), "utf8");
const [homeMarkdown = "", allPages] = index.split(/^## All pages$/m);
if (!allPages) throw new Error('docs/README.md needs an "## All pages" section: its ### groups are the sidebar.');
const sections: { title: string; pages: { file: string; title: string }[] }[] = [];
for (const line of allPages.split("\n")) {
  const heading = /^### (.+)$/.exec(line);
  if (heading?.[1]) sections.push({ title: heading[1], pages: [] });
  const link = /^- \[([^\]]+)\]\(([\w-]+\.md)\)/.exec(line);
  if (link?.[1] && link[2]) sections.at(-1)?.pages.push({ title: link[1], file: link[2] });
}
sections[0]?.pages.unshift({ title: "Overview", file: "README.md" });
const ordered = sections.flatMap((s) => s.pages.map((p) => ({ ...p, group: s.title })));
const files = readdirSync(DOCS).filter((f) => f.endsWith(".md"));
for (const file of files) {
  if (!ordered.some((p) => p.file === file)) {
    throw new Error(`docs/${file} isn't in docs/README.md's "All pages": add it to a group so the sidebar has it.`);
  }
}

/** The h2s of the page being rendered: its "On this page". */
let toc: { id: string; text: string }[] = [];

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
    // image on one of the two, so the build stops. A -dark screenshot with a -light twin shows the one that matches the
    // theme. Each sits on the framed backdrop.
    image({ href, title, text }) {
      if (!href.startsWith(ASSETS) || !existsSync(join(SRC, "assets", href.slice(ASSETS.length)))) {
        throw new Error(
          `A doc shows ${href}: link images as ${ASSETS}<file>, and run \`pnpm screenshots\` for screens.`,
        );
      }
      const src = `/assets/${href.slice(ASSETS.length)}`;
      const light = src.replace(/-dark\.png$/, "-light.png");
      const hasLight = light !== src && existsSync(join(SRC, light));
      const img = (s: string, cls = "") =>
        `<img${cls ? ` class="${cls}"` : ""} src="${esc(s)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ""} loading="lazy" />`;
      return `<a class="shot" href="${esc(src)}">${hasLight ? img(src, "on-dark") + img(light, "on-light") : img(src)}</a>`;
    },
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = idOf(text);
      if (depth === 2) toc.push({ id, text: text.replace(/<[^>]+>/g, "") });
      return `<h${depth} id="${id}">${text}</h${depth}>\n`;
    },
    // A quote that opens with bold words is a callout: a warning for "Warning", "Caution", "Important" or "At a
    // company", a tip for "Tip", a note otherwise.
    blockquote({ tokens }) {
      const body = this.parser.parse(tokens);
      const lead = /^<p><strong>([^<]+)<\/strong>/.exec(body)?.[1];
      if (!lead) return `<blockquote>${body}</blockquote>\n`;
      const kind = /^(warning|caution|important|at a company)/i.test(lead)
        ? "warn"
        : /^tip/i.test(lead)
          ? "tip"
          : "note";
      return `<div class="callout ${kind}" role="note">${body}</div>\n`;
    },
    // Code blocks get a head with what they are (and the copy button, from site.js). Shell blocks of more than one
    // line are numbered, and their # comments are dimmed.
    code({ text, lang }) {
      const language = (lang ?? "").split(/\s/)[0] ?? "";
      const shell = language === "sh" || language === "bash" || language === "shell";
      const lines = text.replace(/\n$/, "").split("\n");
      const body = lines
        .map((line) => {
          const at = shell ? line.search(/(^|\s)#\s/) : -1;
          if (at < 0) return `<span class="line">${esc(line)}</span>`;
          const hash = line.indexOf("#", at);
          return `<span class="line">${esc(line.slice(0, hash))}<span class="cm">${esc(line.slice(hash))}</span></span>`;
        })
        .join("\n");
      const label =
        { sh: "Terminal", bash: "Terminal", shell: "Terminal", json: "JSON", toml: "TOML", md: "Markdown" }[language] ??
        (language === "markdown" ? "Markdown" : language === "text" ? "Output" : language);
      const numbered = shell && lines.length > 1 ? ' class="numbered"' : "";
      return `<div class="code">${label ? `<div class="code-head"><span>${esc(label)}</span></div>` : ""}<pre${numbered}><code>${body}</code></pre></div>\n`;
    },
  },
});

const render = (markdown: string) =>
  marked
    .parse(markdown, { async: false })
    .replaceAll("<table>", '<div class="table"><table>')
    .replaceAll("</table>", "</table></div>");

const PATHWAY_ICONS: Record<string, string> = {
  "getting-started.md": "M3 13l4-4M6 4.5l5.5 5.5M9 2h5v5L8.5 12.5 3.5 7.5Z",
  "queue.md": "M2.5 4h11M2.5 8h11M2.5 12h7",
  "checks.md": "M3.5 8.5l3 3 6-7",
  "models.md": "M8 2v12M2 8h12M4 4l8 8M12 4l-8 8",
  "privacy.md": "M8 1.8l5 2v4c0 3.2-2.2 5.4-5 6.4-2.8-1-5-3.2-5-6.4v-4Z",
  "troubleshooting.md":
    "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.4.2-.7.5-.7 1v.4M8 11.2v.1",
};
const DEFAULT_ICON = "M4 2.5h6l2.5 2.5v8.5h-8.5ZM6.5 8h4M6.5 10.5h4";

/** The docs home's "Start here" list, as a grid of cards. */
function homeHtml(markdown: string): string {
  const start = /^## Start here\n\n((?:- .+\n)+)/m.exec(markdown);
  if (!start?.[1]) return render(markdown);
  const cards = start[1]
    .trim()
    .split("\n")
    .map((line) => {
      const m = /^- \[([^\]]+)\]\(([\w-]+\.md)\): (.+)$/.exec(line);
      if (!m?.[1] || !m[2] || !m[3])
        throw new Error(`docs/README.md's "Start here" has a line the cards can't read: ${line}`);
      const description = marked.parseInline(m[3].charAt(0).toUpperCase() + m[3].slice(1), { async: false });
      return `<a class="card" href="${hrefOf(m[2])}"><span class="card-t"><svg class="icon" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="${PATHWAY_ICONS[m[2]] ?? DEFAULT_ICON}"/></svg>${esc(m[1])}</span><span class="card-d">${description}</span></a>`;
    })
    .join("");
  return render(markdown.replace(start[1], "<!--cards-->\n")).replace(
    "<!--cards-->",
    `<div class="cards">${cards}</div>`,
  );
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
function updatedOf(file: string): string {
  try {
    const day = execFileSync("git", ["log", "-1", "--format=%cs", "--", join("docs", file)], { cwd: ROOT })
      .toString()
      .trim();
    return day ? `Updated ${DATE.format(new Date(`${day}T00:00:00Z`))}` : "";
  } catch {
    return "";
  }
}

const sidebar = (current: string) =>
  `<aside class="docs-side" id="docs-side" aria-label="Docs">
<div class="side-head"><span>Docs</span><button class="side-close" type="button" aria-label="Close navigation">×</button></div>
${sections
  .map(
    (s) =>
      `<details class="grp" open><summary>${esc(s.title)}${ICON.chevron}</summary><div class="grp-items">${s.pages
        .map(
          (p) => `<a href="${hrefOf(p.file)}"${p.file === current ? ' aria-current="page"' : ""}>${esc(p.title)}</a>`,
        )
        .join("")}</div></details>`,
  )
  .join("\n")}
</aside>
<div class="scrim" hidden></div>`;

type Entry = { t: string; p: string; g: string; u: string; s: string; x: string };
const searchIndex: Entry[] = [];

/** Every page and every ## and ### in it, with the text under it, for search. */
function indexPage(file: string, title: string, group: string, markdown: string) {
  const url = hrefOf(file);
  let current: Entry = { t: title, p: "", g: group, u: url, s: "", x: "" };
  searchIndex.push(current);
  for (const token of marked.lexer(markdown)) {
    if (token.type === "heading" && token.depth > 1 && token.depth < 4) {
      const text = marked.parseInline(token.text, { async: false });
      current = { t: plain(token.text), p: title, g: group, u: `${url}#${idOf(text)}`, s: "", x: "" };
      searchIndex.push(current);
    } else if (token.type === "paragraph" || token.type === "list" || token.type === "blockquote") {
      const text = plain(token.text ?? token.raw);
      if (!current.s && token.type === "paragraph" && text) current.s = text.slice(0, 180);
      if (current.x.length < 1200) current.x = `${current.x} ${text}`.trim().slice(0, 1200);
    }
  }
}

for (const [i, entry] of ordered.entries()) {
  const { file, group } = entry;
  const markdown = file === "README.md" ? homeMarkdown : readFileSync(join(DOCS, file), "utf8");
  const title = /^# (.+)$/m.exec(markdown)?.[1] ?? "Alden docs";
  const description =
    markdown
      .split("\n")
      .find((l) => l.trim() && !l.startsWith("#") && !l.startsWith(">"))
      ?.replace(/[`*[\]]/g, "")
      .replace(/\(([^)]+)\)/g, "")
      .slice(0, 160) ?? "Alden documentation";
  toc = [];
  const article = file === "README.md" ? homeHtml(markdown) : render(markdown);
  const pageToc = toc;
  indexPage(file, title, group, markdown);

  const prev = ordered[i - 1];
  const next = ordered[i + 1];
  const updated = updatedOf(file);
  const tocLinks = pageToc.map((t) => `<a href="#${t.id}">${t.text}</a>`).join("");
  const mdPath = `${hrefOf(file)}index.md`;
  const body = `<div class="dlayout">
${sidebar(file)}
<main class="dmain" id="main">
<article class="prose dprose">
${pageToc.length ? `<details class="toc-drop"><summary>On this page${ICON.chevron}</summary><nav aria-label="On this page">${tocLinks}</nav></details>` : ""}
<div class="eyebrow">${esc(group)}</div>
${article}
<div class="page-meta">${OPEN_SOURCE ? `<a href="${REPO}/edit/main/docs/${file}" rel="noopener">Edit on GitHub ↗</a>` : "<span></span>"}<span>${updated}</span></div>
<nav class="pager" aria-label="Previous and next">${prev ? `<a class="prev" href="${hrefOf(prev.file)}"><span>← Previous</span><strong>${esc(prev.title)}</strong></a>` : ""}${next ? `<a class="next" href="${hrefOf(next.file)}"><span>Next →</span><strong>${esc(next.title)}</strong></a>` : ""}</nav>
</article>
</main>
<aside class="rail" aria-label="On this page">
${pageToc.length ? `<div class="rail-t">On this page</div><nav class="rail-toc">${tocLinks}</nav><div class="rail-rule"></div>` : ""}
<button class="copy-page" type="button" data-md="${mdPath}" data-track="copy" data-label="page">${ICON.copy}<span>Copy page</span></button>
</aside>
</div>`;
  const dir = join(OUT, "docs", slugOf(file));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), page(`${title} · Alden docs`, description, body, "docs", true));
  writeFileSync(join(dir, "index.md"), `${markdown.trimEnd()}\n`);
}
writeFileSync(join(OUT, "docs", "search.json"), JSON.stringify(searchIndex));

writeFileSync(
  join(OUT, "404.html"),
  page(
    "Not found · Alden",
    "That page doesn't exist.",
    `<main class="dmain solo"><article class="prose dprose"><h1>Not here</h1><p>That page doesn't exist. Try <a href="/docs/">the docs</a> or <a href="/">the home page</a>.</p></article></main>`,
    null,
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
    "benchmarks",
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
    "cloud",
  ),
);

if (!existsSync(join(OUT, "assets/screens/briefing-dark.png"))) {
  throw new Error("site/src/assets/screens is missing its screenshots. Run `pnpm screenshots`.");
}
console.log(
  `Built ${files.length} docs pages and their search index, the benchmarks, Alden Cloud and the home page into site/dist${OPEN_SOURCE ? ", saying Alden is open source (ALDEN_OPEN_SOURCE=1)" : ""}.`,
);
