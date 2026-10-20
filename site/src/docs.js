// The docs frame's moving parts, on the docs, /benchmarks/ and /cloud/: search (⌘K), the sidebar as a drawer on a
// phone, "On this page" with the section you're reading, Copy page, and the theme switch in the footer. Everything
// works without it except search and the switch: the sidebar and "On this page" are plain links.

const root = document.documentElement;

// --- Theme ----------------------------------------------------------------------------------------------------------
// System follows prefers-color-scheme (docs.css); Light and Dark are remembered on this device.
{
  const buttons = [...document.querySelectorAll("[data-theme-set]")];
  const show = () => {
    const current = root.dataset.theme ?? "system";
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.themeSet === current));
  };
  for (const b of buttons) {
    b.addEventListener("click", () => {
      const theme = b.dataset.themeSet;
      if (theme === "system") delete root.dataset.theme;
      else root.dataset.theme = theme;
      try {
        if (theme === "system") localStorage.removeItem("alden-theme");
        else localStorage.setItem("alden-theme", theme);
      } catch {}
      show();
    });
  }
  show();
}

// --- The sidebar as a drawer, below 900 px ----------------------------------------------------------------------------
{
  const menu = document.querySelector(".menu-btn");
  const side = document.getElementById("docs-side");
  const scrim = document.querySelector(".scrim");
  if (menu && side && scrim) {
    const set = (open) => {
      root.classList.toggle("nav-open", open);
      menu.setAttribute("aria-expanded", String(open));
      scrim.hidden = !open;
      if (open) side.querySelector('[aria-current="page"], a')?.focus();
      else menu.focus();
    };
    menu.addEventListener("click", () => set(true));
    scrim.addEventListener("click", () => set(false));
    side.querySelector(".side-close")?.addEventListener("click", () => set(false));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && root.classList.contains("nav-open")) set(false);
    });
    // The current page's link starts in view in a long sidebar.
    // (scrollTop rather than scrollIntoView, which can scroll the page as well.)
    const current = side.querySelector('[aria-current="page"]');
    if (current instanceof HTMLElement && current.offsetTop + current.offsetHeight > side.clientHeight) {
      side.scrollTop = current.offsetTop - side.clientHeight / 2;
    }
  }
}

// --- On this page: the section you're reading -------------------------------------------------------------------------
{
  const links = [...document.querySelectorAll(".rail-toc a")];
  const headings = links.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1)))).filter(Boolean);
  if (headings.length) {
    let ticking = false;
    const spy = () => {
      ticking = false;
      let active = headings[0].id;
      for (const h of headings) if (h.getBoundingClientRect().top < 120) active = h.id;
      // At the end of the page the last sections can't scroll up to the top, so the last one is current.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) active = headings.at(-1).id;
      for (const a of links) {
        if (a.hash.slice(1) === active) a.setAttribute("aria-current", "location");
        else a.removeAttribute("aria-current");
      }
    };
    window.addEventListener(
      "scroll",
      () => {
        if (!ticking) requestAnimationFrame(spy);
        ticking = true;
      },
      { passive: true },
    );
    spy();
  }
  // Picking a section from the dropdown closes it.
  const drop = document.querySelector(".toc-drop");
  drop?.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest("a")) drop.open = false;
  });
}

// --- Copy page, as Markdown -------------------------------------------------------------------------------------------
{
  const button = document.querySelector(".copy-page");
  const label = button?.querySelector("span");
  if (button && label && navigator.clipboard) {
    button.addEventListener("click", () => {
      const text = fetch(button.dataset.md).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))));
      // Safari only lets a page write to the clipboard during the click, so hand it the text as a promise.
      const write =
        typeof ClipboardItem === "function"
          ? navigator.clipboard.write([
              new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) }),
            ])
          : text.then((t) => navigator.clipboard.writeText(t));
      write.then(
        () => {
          label.textContent = "Copied as Markdown";
          setTimeout(() => {
            label.textContent = "Copy page";
          }, 1600);
        },
        () => {
          label.textContent = "Couldn't copy";
        },
      );
    });
  } else if (button) button.hidden = true;
}

// --- Search -----------------------------------------------------------------------------------------------------------
// The index is /docs/search.json, built with the site: every page and every section in it. It's fetched the first
// time search opens, and searched here: nothing you type leaves the page.
{
  const dialog = document.querySelector(".search");
  const input = dialog?.querySelector("input");
  const list = dialog?.querySelector(".search-results");
  const openers = document.querySelectorAll(".search-btn");
  if (dialog && input && list) {
    let entries = null;
    let hits = [];
    let sel = 0;
    let lastFocus = null;
    const load = () => {
      entries ??= fetch("/docs/search.json")
        .then((r) => r.json())
        .catch(() => []);
      return entries;
    };
    const el = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    // Text with each matched word underlined, built as DOM nodes, so nothing from the index is read as HTML.
    const marked = (text, terms) => {
      const frag = document.createDocumentFragment();
      if (!terms.length) {
        frag.append(text);
        return frag;
      }
      const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
      for (const part of text.split(pattern)) {
        if (!part) continue;
        if (terms.some((t) => t === part.toLowerCase())) frag.append(el("mark", "", part));
        else frag.append(part);
      }
      return frag;
    };
    // The words around the first match in a section's text, when its first line doesn't have one.
    const excerpt = (entry, terms) => {
      const s = entry.s || entry.x.slice(0, 180);
      if (!terms.length || terms.some((t) => s.toLowerCase().includes(t))) return s;
      const lower = entry.x.toLowerCase();
      const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0));
      if (!Number.isFinite(at)) return s;
      const start = Math.max(0, entry.x.lastIndexOf(" ", Math.max(0, at - 60)) + 1);
      return `${start > 0 ? "…" : ""}${entry.x.slice(start, start + 180)}…`;
    };
    const score = (entry, q, terms) => {
      const title = entry.t.toLowerCase();
      const all = `${title} ${entry.p.toLowerCase()} ${entry.x.toLowerCase()}`;
      if (!terms.every((t) => all.includes(t))) return 0;
      let n = 1;
      if (title === q) n += 20;
      if (title.includes(q)) n += 10;
      for (const t of terms) if (title.includes(t)) n += 3;
      if (!entry.p) n += 2;
      return n;
    };
    const draw = async () => {
      const all = await load();
      const q = input.value.trim().toLowerCase();
      const terms = q.split(/\s+/).filter(Boolean);
      hits = q
        ? all
            .map((e, i) => ({ e, n: score(e, q, terms), i }))
            .filter((h) => h.n > 0)
            .sort((a, b) => b.n - a.n || a.i - b.i)
            .slice(0, 8)
            .map((h) => h.e)
        : all.filter((e) => !e.p).slice(1, 7);
      sel = Math.min(sel, Math.max(0, hits.length - 1));
      list.replaceChildren();
      if (q && hits.length === 0) {
        list.append(el("div", "search-empty", `No results for “${input.value.trim()}”.`));
        input.removeAttribute("aria-activedescendant");
        return;
      }
      hits.forEach((entry, i) => {
        const a = el("a", "hit");
        a.href = entry.u;
        a.id = `hit-${i}`;
        a.setAttribute("role", "option");
        a.setAttribute("aria-selected", String(i === sel));
        a.append(el("span", "hit-crumb", `Docs › ${entry.g}${entry.p ? ` › ${entry.p}` : ""}`));
        const title = el("span", "hit-title");
        title.append(marked(entry.t, terms));
        const snip = el("span", "hit-snip");
        snip.append(marked(excerpt(entry, terms), terms));
        a.append(title, snip);
        a.addEventListener("mousemove", () => {
          if (sel !== i) {
            sel = i;
            mark();
          }
        });
        a.addEventListener("click", () => close(false));
        list.append(a);
      });
      mark();
    };
    const mark = () => {
      for (const [i, a] of [...list.querySelectorAll(".hit")].entries()) {
        a.setAttribute("aria-selected", String(i === sel));
        if (i === sel) {
          a.scrollIntoView({ block: "nearest" });
          input.setAttribute("aria-activedescendant", a.id);
        }
      }
    };
    const open = () => {
      if (!dialog.hidden) return;
      lastFocus = document.activeElement;
      dialog.hidden = false;
      root.classList.add("search-open");
      input.select();
      input.focus();
      draw();
    };
    const close = (restore = true) => {
      if (dialog.hidden) return;
      dialog.hidden = true;
      root.classList.remove("search-open");
      if (restore && lastFocus instanceof HTMLElement) lastFocus.focus();
    };
    for (const b of openers) b.addEventListener("click", open);
    input.addEventListener("input", () => {
      sel = 0;
      draw();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        sel = Math.max(0, Math.min(hits.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1)));
        mark();
      } else if (e.key === "Enter" && hits[sel]) {
        e.preventDefault();
        close(false);
        location.href = hits[sel].u;
      }
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) close();
    });
    // Tab stays inside the dialog: the input is its only control besides the results.
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        input.focus();
      }
    });
    document.addEventListener("keydown", (e) => {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (dialog.hidden) open();
        else close();
      } else if (e.key === "/" && !typing && dialog.hidden) {
        e.preventDefault();
        open();
      } else if (e.key === "Escape" && !dialog.hidden) close();
    });
    // ⌘ on a Mac, Ctrl elsewhere.
    if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
      for (const kbd of document.querySelectorAll(".search-btn kbd")) kbd.textContent = "Ctrl K";
    }
  }
}
