import type { Briefing } from "@alden/schema";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import type { Api } from "../api";
import { typing } from "./Comments";

type Exporter = Pick<Api, "briefingMarkdown" | "saveBriefing">;
type Doc = Awaited<ReturnType<Api["briefingMarkdown"]>>;

/** The Markdown for one briefing, fetched once when the menu opens, so copying needs no wait. */
interface Pending {
  briefing: Briefing;
  promise: Promise<Doc>;
  value?: Doc;
}

/** Copies text, falling back to a hidden text area where the clipboard API isn't allowed. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // an older webview, or no permission: try the old way
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand?.("copy") ?? false;
  area.remove();
  if (!copied) throw new Error("the clipboard isn't available here");
}

/** Saves text as a file the browser downloads. */
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Export in the briefing's toolbar: copy it as Markdown, save it as a Markdown file, or print it (and so save a PDF).
 * `e` opens it from the keyboard (never while you type), the arrows move through it, Esc closes it. The desktop app's
 * window can't download files, so there the server saves to Downloads and says where.
 */
export function ExportMenu({ briefing, api, desktop }: { briefing: Briefing; api: Exporter; desktop: boolean }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string }>();
  const pending = useRef<Pending | undefined>(undefined);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  const load = (): Pending => {
    if (pending.current?.briefing !== briefing) {
      const entry: Pending = { briefing, promise: api.briefingMarkdown(briefing) };
      entry.promise.then(
        (doc) => {
          entry.value = doc;
        },
        () => {},
      );
      pending.current = entry;
    }
    return pending.current;
  };

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const toggle = () => {
    if (open) return close();
    load();
    setNote(undefined);
    setOpen(true);
  };
  const latest = useRef(toggle);
  latest.current = toggle;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "e" || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [open]);

  // A note fades after a few seconds; an error stays until the next try.
  useEffect(() => {
    if (note?.tone !== "ok") return;
    const timer = setTimeout(() => setNote(undefined), 4_000);
    return () => clearTimeout(timer);
  }, [note]);

  const fail = (what: string) => (error: unknown) =>
    setNote({ tone: "error", text: `Couldn't ${what}: ${error instanceof Error ? error.message : String(error)}` });

  const copy = () => {
    close();
    const entry = load();
    // Straight from the click when the Markdown is here already: some webviews only allow the clipboard then.
    const copied = entry.value ? copyText(entry.value.markdown) : entry.promise.then((doc) => copyText(doc.markdown));
    copied.then(() => setNote({ tone: "ok", text: "Copied as Markdown." }), fail("copy it"));
  };

  const save = () => {
    close();
    if (desktop) {
      api
        .saveBriefing(briefing)
        .then((saved) => setNote({ tone: "ok", text: `Saved to ${saved.shown}.` }), fail("save it"));
      return;
    }
    load().promise.then((doc) => {
      download(doc.fileName, doc.markdown);
      setNote({ tone: "ok", text: `Downloaded ${doc.fileName}.` });
    }, fail("save it"));
  };

  const print = () => {
    close();
    try {
      // The desktop app's window prints through the app, and says no with a rejected promise.
      const result = window.print() as unknown;
      if (result instanceof Promise) result.catch(fail("print"));
    } catch (error) {
      fail("print")(error);
    }
  };

  const onMenuKey = (event: ReactKeyboardEvent) => {
    // Keys in the menu stay in the menu: c, s, j and k mean other things on the page.
    if (event.key !== "Tab") event.nativeEvent.stopPropagation();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(items.length - 1);
    else if (event.key === "Escape" || event.key === "e") close();
    else return;
    event.preventDefault();
  };

  return (
    <div className="export" ref={wrapper}>
      {note && (
        <span className={`export-note small${note.tone === "error" ? " error-text" : " faint"}`} role="status">
          {note.text}
        </span>
      )}
      <button
        ref={button}
        type="button"
        className="btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "export-menu" : undefined}
        onClick={toggle}
      >
        Export <kbd>E</kbd>
      </button>
      {open && (
        <div
          ref={menu}
          id="export-menu"
          className="export-menu card"
          role="menu"
          tabIndex={-1}
          onKeyDown={onMenuKey}
          // Focus going anywhere else (a click outside, Tab) closes it.
          onBlur={(event) => {
            if (!wrapper.current?.contains(event.relatedTarget as Node | null)) close(false);
          }}
          // Clicking an item mustn't move focus first: WebKit would close the menu before the click lands.
          onMouseDown={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" tabIndex={-1} onClick={copy}>
            Copy as Markdown
          </button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={save}>
            Save as Markdown
            <span className="faint small">{desktop ? "to Downloads" : ".md file"}</span>
          </button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={print}>
            Print / Save as PDF
          </button>
        </div>
      )}
    </div>
  );
}
