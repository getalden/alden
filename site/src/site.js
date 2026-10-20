// Every page of getalden.dev loads this: page view counts, copy buttons, and the landing page's moving parts.

// --- Page view counts ---------------------------------------------------------------------------------------------
// To help us improve the site, it counts page views and clicks on install, copy and Discord links, in PostHog's EU
// cloud, with the same public key as Alden's opt-in usage stats. No cookies, no storage and no third-party script:
// each page load gets a fresh random id, and no person profile is made. What's sent is the path (never the query
// string), the referring site's domain, a rough screen width, and which link was clicked. Do Not Track and Global
// Privacy Control turn it off. See /docs/privacy/.
const track = (() => {
  const off =
    navigator.doNotTrack === "1" ||
    window.doNotTrack === "1" ||
    navigator.globalPrivacyControl === true ||
    !/^(www\.)?getalden\.dev$/.test(location.hostname);
  if (off) return () => {};
  const id = crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  let referrer = "$direct";
  try {
    if (document.referrer) referrer = new URL(document.referrer).hostname;
  } catch {}
  const w = window.innerWidth;
  const base = {
    distinct_id: id,
    $process_person_profile: false,
    $ip: null,
    $geoip_disable: true,
    $lib: "getalden.dev",
    $current_url: location.origin + location.pathname,
    $host: location.hostname,
    $pathname: location.pathname,
    $referring_domain: referrer,
    screen: w < 640 ? "phone" : w < 1024 ? "tablet" : w < 1440 ? "laptop" : "wide",
  };
  return (event, properties = {}) => {
    try {
      fetch("https://eu.i.posthog.com/batch/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: "phc_qkSGWofnv9C9YLomkc3jAPbDfVe8hFEsy6dCzbsfj9Mb",
          batch: [{ event, timestamp: new Date().toISOString(), properties: { ...base, ...properties } }],
        }),
        credentials: "omit",
        keepalive: true,
      }).catch(() => {});
    } catch {}
  };
})();
track("$pageview");
document.addEventListener("click", (e) => {
  const link = e.target instanceof Element ? e.target.closest("a, button") : null;
  if (!link) return;
  const href = link.getAttribute("href") ?? "";
  const cta = link.dataset.track ?? (href.includes("discord.gg") ? "discord" : null);
  if (cta) track("site_click", { cta, label: link.dataset.label ?? null });
});

// --- Copy buttons -------------------------------------------------------------------------------------------------
// Every command marked data-copy on the landing page, and every code block in the docs, gets a Copy button.
for (const box of document.querySelectorAll("[data-copy], .prose pre")) {
  if (!navigator.clipboard) break;
  const code = box.querySelector("code") ?? box;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-btn";
  button.textContent = "Copy";
  button.dataset.track = "copy";
  button.dataset.label = box.dataset.copy ?? location.pathname;
  button.setAttribute("aria-label", `Copy ${box.dataset.copy ? "the command" : "this code"}`);
  button.addEventListener("click", () => {
    // Comments after a # are notes for the reader, and zsh doesn't allow them at its prompt by default.
    const text = code.textContent
      .split("\n")
      .map((line) => line.replace(/\s+#\s.*$/, ""))
      .join("\n")
      .trim();
    navigator.clipboard.writeText(text).then(
      () => {
        button.textContent = "Copied";
        setTimeout(() => {
          button.textContent = "Copy";
        }, 1600);
      },
      () => {},
    );
  });
  // A docs code block with a head ("Terminal", "JSON"…) carries its button there.
  const head = box.closest(".code")?.querySelector(".code-head");
  if (head) head.append(button);
  else {
    box.classList.add("has-copy");
    box.append(button);
  }
}

// --- The landing page's moving parts ------------------------------------------------------------------------------
// Each one starts in a sensible still state, so with reduced motion (or without JavaScript) the page reads the same,
// just without the motion. Other pages don't have them, and a doc's heading can share one of their ids (the
// Configuration page's "queue" heading is #queue), so this checks for the landing page itself.
(() => {
  if (!document.querySelector(".hero-wrap")) return;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // --- Hero: a queue sorted by date becomes a queue ranked for you ---------------------------------------------
  const prs = [
    ["Add worktree checkout to `gh issue develop`", "cli/cli#14136 · 2d", "large, tests changed", 34],
    [
      "RecentlyDeleted: show when each dashboard was deleted",
      "grafana#133734 · 5d",
      "large · 3 PRs waiting on you",
      62,
    ],
    ["[13.x] Run workflows on Ubuntu 26.04", "laravel#60005 · 4d", "touches .github/workflows/", 48],
    [
      "Fixed lookup crashes after subquery annotations",
      "django#19057 · 5d",
      "migration may lose data · waiting 5d",
      91,
    ],
    ["fix(swc): normalize codeFrameColumns options", "next.js#99367 · 3d", "no test changes", 40],
    ["docs: fix the matcher example", "next.js#99371 · 2h", "docs only · fast-track", 6],
  ];
  const queue = $("queue");
  const status = $("q-status");
  const rows = prs.map(([title, sub, why, score]) => {
    const row = el("div", "qrow");
    row.append(el("span", "pos"));
    const what = el("span", "what");
    what.append(el("span", "title", title), el("span", "sub", sub));
    const bar = el("span", "bar");
    bar.append(el("span"));
    row.append(what, bar, el("span", "score", "··"));
    queue.append(row);
    return { row, sub, why, score };
  });
  const order = rows.map((_, i) => i).sort((a, b) => rows[b].score - rows[a].score);
  const drawQueue = (phase) => {
    rows.forEach((r, i) => {
      const pos = phase === 2 ? order.indexOf(i) : i;
      r.row.style.top = `${pos * 66}px`;
      r.row.classList.toggle("first", phase === 2 && pos === 0);
      r.row.querySelector(".pos").textContent = String(pos + 1).padStart(2, "0");
      r.row.querySelector(".sub").textContent = phase ? r.why : r.sub;
      const fill = r.row.querySelector(".bar span");
      fill.style.width = phase ? `${r.score}%` : "0";
      fill.classList.toggle("hot", r.score > 70);
      const score = r.row.querySelector(".score");
      score.textContent = phase ? r.score : "··";
      score.classList.toggle("hot", phase > 0 && r.score > 70);
    });
    queue.classList.toggle("scoring", phase === 1);
    status.textContent = ["sorted by date", "scoring 6 PRs…", "ranked for you"][phase];
    status.classList.toggle("done", phase === 2);
  };

  // --- Beyond the diff: the change, then its callers one by one ---------------------------------------------------
  const diffLines = [
    ["21", " ", "export function revalidatePath(originalPath, type) {"],
    ["22", "−", "  if (!store) return"],
    ["22", "+", "  if (!store) {"],
    ["23", "+", "    throw new InvariantError('revalidatePath outside a request')"],
    ["24", "+", "  }"],
    ["25", " ", "  const path = normalize(originalPath, type)"],
    ["26", "+", "  store.pendingRevalidates.add(routeKey(path))"],
  ];
  const diff = $("diff");
  const lines = diffLines.map(([n, m, t]) => {
    const line = el("div", `dl ${m === "+" ? "add" : m === "−" ? "del" : "ctx"}`);
    line.append(el("span", "n", n), el("span", "m", m), el("span", "t", t));
    diff.append(line);
    return line;
  });
  const callerData = [
    ["action-handler.ts:207", "await revalidatePath(path, 'page')", false],
    ["router-server.ts:388", "try { revalidatePath(p) } catch {…}", true],
    ["api-resolver.ts:142", "revalidatePath(req.query.path)", false],
    ["cache-handler.ts:56", "revalidatePath(tag.path, 'layout')", false],
  ];
  const callersBox = $("callers");
  const callers = callerData.map(([loc, code, ok]) => {
    const card = el("div", `caller${ok ? "" : " miss"}`);
    const top = el("span", "row");
    top.append(el("span", "loc", loc), el("span", "tag", ok ? "catches" : "no catch"));
    card.append(top, el("code", "", code));
    callersBox.append(card);
    return card;
  });
  const ctx = $("ctx");
  const drawCallers = (step) => {
    lines[3].classList.toggle("hot", step >= 2);
    const shown = Math.max(0, Math.min(4, Math.floor((step - 4) / 2) + 1));
    callers.forEach((card, i) => {
      card.classList.toggle("shown", i < shown);
    });
    ctx.textContent =
      shown === 0
        ? "reading local clone…"
        : shown < 4
          ? `found ${shown} of 7 call sites`
          : "7 call sites · 3 miss the new throw";
  };

  // --- Learns you: what one reviewer's Memory looks like, week by week -------------------------------------------
  const learned = [
    { per: 5, useful: 31, log: "marked 9 places across 4 PRs" },
    {
      per: 4.4,
      useful: 42,
      item: ["look", "You care about migration flags", "you marked 3 of 3 useful"],
      log: "kept 3 migration flags",
    },
    {
      per: 3.6,
      useful: 55,
      item: ["skip", "You usually mark untested-change flags not useful", "marked 4 of 5 not useful"],
      log: "untested-change flags now step aside",
    },
    {
      per: 3.1,
      useful: 63,
      item: ["look", "You open PRs in app/api/ first", "opened ahead of their rank 4 times"],
      log: "app/api/ PRs now rank higher",
    },
    {
      per: 2.7,
      useful: 71,
      item: ["you said", "Server actions must check the session first", "your note, given to the model"],
      log: "added a note for the model",
    },
    {
      per: 2.4,
      useful: 78,
      item: ["skip", "You skip PRs labelled docs", "marked not useful 3 times"],
      log: "docs PRs now rank lower",
    },
  ];
  const weeksBox = $("weeks");
  let pinned = null;
  const weekButtons = learned.map((_, i) => {
    const button = el("button", "", `wk ${i + 1}`);
    button.type = "button";
    button.addEventListener("click", () => {
      pinned = pinned === i + 1 ? null : i + 1;
      drawWeek(pinned ?? i + 1);
    });
    weeksBox.append(button);
    return button;
  });
  const drawWeek = (week) => {
    const w = learned[week - 1];
    weekButtons.forEach((b, i) => {
      b.setAttribute("aria-pressed", String(i + 1 === week));
    });
    $("week-label").textContent = `week ${week}`;
    $("per-pr").textContent = String(w.per);
    $("useful").textContent = `${w.useful}%`;
    const list = $("memory");
    list.replaceChildren();
    const items = learned.slice(0, week).flatMap((x) => (x.item ? [x.item] : []));
    if (items.length === 0) {
      const li = el("li");
      li.append(el("span", "empty", "Nothing yet. Alden waits for three reactions before it changes anything."));
      list.append(li);
    }
    for (const [grp, text, ev] of items) {
      const li = el("li");
      const what = el("span", "", text);
      what.append(el("span", "ev", ev));
      li.append(
        el(
          "span",
          `grp${grp === "skip" ? " skip" : ""}`,
          grp === "skip" ? "skip" : grp === "you said" ? "you said" : "look for",
        ),
        what,
      );
      list.append(li);
    }
    const log = $("log");
    log.replaceChildren();
    for (let i = Math.max(0, week - 3); i < week; i++) {
      const line = el("div");
      line.append(el("b", "", `w${i + 1}`), document.createTextNode(learned[i].log));
      log.append(line);
    }
  };

  // --- The terminal ------------------------------------------------------------------------------------------------
  const term = [
    ["$ alden queue", "var(--ink)"],
    ["", ""],
    ["needs you · 4", "var(--ink3)"],
    ["01  Fixed lookup crashes after subquery annotations  django#19057", "var(--acc2)"],
    ["02  RecentlyDeleted: show when each dashboard was…    grafana#133734", "var(--ink)"],
    ["03  [13.x] Run workflows on Ubuntu 26.04              laravel#60005", "var(--ink2)"],
    ["04  fix(swc): normalize codeFrameColumns options      next.js#99367", "var(--ink2)"],
    ["", ""],
    ["$ alden review 1", "var(--ink)"],
    ["Needs your eyes", "var(--ink3)"],
    ["  1. Migration in tests/migrations/test_operations.py:2347", "var(--warn)"],
  ];
  const termBox = $("term-lines");
  const drawTerm = (n) => {
    termBox.replaceChildren(
      ...term.slice(0, n).map(([t, c]) => {
        const line = el("div", "", t || " ");
        line.style.color = c;
        return line;
      }),
    );
  };

  if (still) {
    drawQueue(2);
    drawCallers(99);
    drawWeek(6);
    drawTerm(term.length);
    return;
  }
  let tick = 0;
  drawQueue(0);
  drawCallers(0);
  drawWeek(1);
  drawTerm(1);
  setInterval(() => {
    tick++;
    const q = tick % 22;
    drawQueue(q < 4 ? 0 : q < 9 ? 1 : 2);
    drawCallers(tick % 26);
    if (pinned === null) drawWeek((Math.floor(tick / 6) % 6) + 1);
    drawTerm(Math.min(term.length, Math.max(1, (tick % 30) - 1)));
  }, 450);
})();
