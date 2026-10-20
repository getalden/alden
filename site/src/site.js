// Every page of getalden.dev loads this: page view counts, copy buttons, and the landing page's pickers.

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

// --- The landing page's parts you can pick -------------------------------------------------------------------------
// The download button names your OS, the header folds into a menu on a phone, and three illustrations take a pick:
// a week of Memory, a tone for the same draft, and where you use Alden. Without JavaScript each shows its default.
// Other pages don't have them, so this checks for the landing page itself.
(() => {
  if (!document.documentElement.classList.contains("home")) return;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Download for macOS, Windows or Linux: all three are on the releases page.
  const ua = navigator.userAgent;
  const os = /Win/.test(ua) ? "Windows" : /Linux/.test(ua) && !/Android/.test(ua) ? "Linux" : "macOS";
  const download = $("download")?.querySelector("span");
  if (download) download.textContent = `Download for ${os}`;

  // The header's menu, below 820 px.
  const menu = document.querySelector(".hmenu");
  const nav = $("hnav");
  if (menu && nav) {
    menu.addEventListener("click", () => {
      const open = !document.documentElement.classList.contains("menu-open");
      document.documentElement.classList.toggle("menu-open", open);
      menu.setAttribute("aria-expanded", String(open));
    });
    nav.addEventListener("click", (e) => {
      if (e.target instanceof Element && e.target.closest("a")) {
        document.documentElement.classList.remove("menu-open");
        menu.setAttribute("aria-expanded", "false");
      }
    });
  }

  // Buttons that pick one of a few, as aria-pressed.
  const picker = (box, labels, current, onPick) => {
    const buttons = labels.map((label, i) => {
      const b = el("button", "", label);
      b.type = "button";
      b.addEventListener("click", () => {
        for (const [j, other] of buttons.entries()) other.setAttribute("aria-pressed", String(i === j));
        onPick(i);
      });
      b.setAttribute("aria-pressed", String(i === current));
      return b;
    });
    box.replaceChildren(...buttons);
  };

  // Learns you: one reviewer's Memory, week by week.
  const weeks = [
    { places: "11.2", useful: "12%", learned: [["learning", "Nothing yet. Mark places useful or not as you review."]] },
    { places: "9.1", useful: "18%", learned: [["look for", "Migration changes. You marked 3 of 3 useful."]] },
    {
      places: "7.4",
      useful: "25%",
      learned: [
        ["look for", "Migration changes. You marked 5 of 5 useful."],
        ["skip", "Snapshot-only test updates."],
      ],
    },
    {
      places: "6.0",
      useful: "31%",
      learned: [
        ["look for", "Migration changes, and callers that drop errors."],
        ["skip", "Snapshot-only test updates."],
      ],
    },
    {
      places: "5.1",
      useful: "37%",
      learned: [
        ["look for", "Migration changes, and callers that drop errors."],
        ["skip", "Snapshot updates and lockfile-only diffs."],
      ],
    },
    {
      places: "4.4",
      useful: "42%",
      learned: [
        ["look for", "Migration changes, and callers that drop errors."],
        ["skip", "Snapshot updates and lockfile-only diffs."],
        ["your note", '"Ask for a test when a public API changes."'],
      ],
    },
  ];
  const weeksBox = $("weeks");
  if (weeksBox) {
    picker(
      weeksBox,
      weeks.map((_, i) => `wk ${i + 1}`),
      weeks.length - 1,
      (i) => {
        const w = weeks[i];
        $("week-label").textContent = `week ${i + 1}`;
        $("per-pr").textContent = w.places;
        $("useful").textContent = w.useful;
        $("memory").replaceChildren(
          ...w.learned.map(([k, v]) => {
            const row = el("div", "mem-item");
            row.append(el("span", "k", k), el("span", "", v));
            return row;
          }),
        );
      },
    );
  }

  // Drafts in your tone: the same comment, four ways.
  const drafts = {
    Terse: "This throws InvariantError now and this caller has no catch. Handle it here?",
    Concise:
      "invalidatePath now throws InvariantError outside a request, but this call has no catch, so a server action would fail with a 500. Should it handle that case?",
    Detailed:
      "After this change invalidatePath throws InvariantError when it runs outside a request. This handler calls it without a try/catch, so a server action that revalidates during a background job would now surface a 500. Could we catch it here, or document that callers must be inside a request?",
    Teaching:
      "Worth a look: invalidatePath used to fail quietly outside a request and now throws. Code that called it from a background job (like this handler) was relying on the quiet version. A small catch here, or a note in the docs, keeps those callers working.",
  };
  const tonesBox = $("tones");
  if (tonesBox) {
    const names = Object.keys(drafts);
    picker(tonesBox, names, 1, (i) => {
      $("draft").textContent = drafts[names[i]];
    });
  }

  // Works where you do: tabs, with the arrow keys moving between them.
  const tabs = [...document.querySelectorAll('.place-tabs [role="tab"]')];
  const select = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = $(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
  };
  for (const [i, tab] of tabs.entries()) {
    tab.addEventListener("click", () => select(tab, false));
    tab.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      select(tabs[(i + step + tabs.length) % tabs.length], true);
    });
  }
})();
