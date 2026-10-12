import { Fragment, type ReactNode } from "react";

/*
 * A model's answer as Markdown, for reading: paragraphs, lists, headings, code blocks, inline code, bold, italic and
 * links. It builds React elements and never sets HTML, so text the model quotes from a PR can't become markup. Links
 * are http(s) only; anything else stays text.
 */

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "code"; text: string }
  | { kind: "ul" | "ol"; items: string[] };

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

/** Splits the text into blocks, line by line. */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  const endPara = () => {
    if (para.length > 0) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fence = FENCE.exec(line);
    if (fence) {
      endPara();
      const close = fence[1] as string;
      const code: string[] = [];
      for (i++; i < lines.length && !(lines[i] as string).trim().startsWith(close); i++) code.push(lines[i] as string);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      endPara();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endPara();
      blocks.push({ kind: "h", text: heading[1] as string });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      endPara();
      const kind = bullet ? "ul" : "ol";
      const item = ((bullet ?? numbered) as RegExpExecArray)[1] as string;
      const last = blocks.at(-1);
      if (last && last.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
      continue;
    }
    // A wrapped line under a list item belongs to it.
    const last = blocks.at(-1);
    if (para.length === 0 && last && (last.kind === "ul" || last.kind === "ol") && /^\s+\S/.test(line)) {
      last.items[last.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  endPara();
  return blocks;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/;

/** Inline code, bold, italic and links in one line of text. */
export function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const [whole, code, bold, italic, link] = m;
    const k = `${key}.${n++}`;
    if (code) out.push(<code key={k}>{code.slice(1, -1)}</code>);
    else if (bold) out.push(<strong key={k}>{inline(bold.slice(2, -2), k)}</strong>);
    else if (italic) out.push(<em key={k}>{inline(italic.slice(1, -1), k)}</em>);
    else if (link) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(link) as RegExpExecArray;
      out.push(
        /^https?:\/\//i.test(href as string) ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        ) : (
          <Fragment key={k}>{label}</Fragment>
        ),
      );
    }
    rest = rest.slice(m.index + whole.length);
  }
  return out;
}

export function Markdown(props: { text: string; className?: string }) {
  return (
    <div className={`md${props.className ? ` ${props.className}` : ""}`}>
      {blocksOf(props.text).map((b, i) => {
        const key = `b${i}`;
        if (b.kind === "code")
          return (
            <pre key={key}>
              <code>{b.text}</code>
            </pre>
          );
        if (b.kind === "h")
          return (
            <p key={key} className="md-h">
              {inline(b.text, key)}
            </p>
          );
        if (b.kind === "p") return <p key={key}>{inline(b.text, key)}</p>;
        // biome-ignore lint/suspicious/noArrayIndexKey: an answer's items never move, so their places are stable keys
        const items = b.items.map((item, j) => <li key={`${key}.${j}`}>{inline(item, `${key}.${j}`)}</li>);
        return b.kind === "ul" ? <ul key={key}>{items}</ul> : <ol key={key}>{items}</ol>;
      })}
    </div>
  );
}
