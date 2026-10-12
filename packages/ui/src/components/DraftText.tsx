import { useId, useLayoutEffect, useRef, useState } from "react";

/*
 * A comment's text in a list of drafts: its first four lines, with Show all / Show less when there's more, so a long
 * draft can be read where it is without opening it to edit.
 */

/** Long enough to be cut at four lines, by its text alone: for when nothing is laid out to measure (a hidden drawer). */
const looksLong = (text: string) => text.split("\n").length > 4 || text.length > 240;

export function DraftText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const body = useRef<HTMLParagraphElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || open) return;
    const measure = () => setCut(el.clientHeight > 0 ? el.scrollHeight > el.clientHeight + 1 : looksLong(text));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [text, open]);
  return (
    <>
      <p ref={body} id={id} className={`draft-body excerpt${open ? " open" : ""}`}>
        {text}
      </p>
      {(open || cut) && (
        <button
          type="button"
          className="link-button small draft-more"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </>
  );
}
