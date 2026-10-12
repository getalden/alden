/**
 * Drawing whole screens on a terminal: the renderers make lines with colour codes in them, and these cut them to the
 * terminal's width by what's visible, never in the middle of a code.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: the colour codes the renderers write
const SGR = /\u001b\[[0-9;]*m/y;

/** The columns a line takes: its characters, without colour codes. Emoji and CJK may take two; they count as one. */
export function visibleWidth(line: string): number {
  let width = 0;
  for (let i = 0; i < line.length; ) {
    SGR.lastIndex = i;
    const code = SGR.exec(line);
    if (code) {
      i += code[0].length;
      continue;
    }
    const step = (line.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    width++;
    i += step;
  }
  return width;
}

/** Cuts a line to `width` columns, keeping its colour codes; a cut line ends with "…" and every style reset. */
export function truncate(line: string, width: number): string {
  if (visibleWidth(line) <= width) return line;
  let out = "";
  let shown = 0;
  for (let i = 0; i < line.length; ) {
    SGR.lastIndex = i;
    const code = SGR.exec(line);
    if (code) {
      out += code[0];
      i += code[0].length;
      continue;
    }
    if (shown === width - 1) break;
    const step = (line.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    out += line.slice(i, i + step);
    shown++;
    i += step;
  }
  return `${out}${width > 0 ? "…" : ""}\u001b[0m`;
}

/** What the terminal is sent around a session: the alternate screen with the cursor hidden, and back. */
export const ENTER = "\u001b[?1049h\u001b[?25l\u001b[H\u001b[2J";
export const LEAVE = "\u001b[0m\u001b[?25h\u001b[?1049l";

/**
 * One frame: from the top-left, each line cut to the width with the rest of its row cleared, then everything below
 * cleared. Written whole, so the screen never shows half of one.
 */
export function frame(lines: string[], width: number): string {
  const row = (line: string) => {
    const cut = truncate(line, width);
    // A full row leaves the cursor on its last column, where clearing would erase that column's character.
    return visibleWidth(cut) >= width ? `${cut}\u001b[0m` : `${cut}\u001b[0m\u001b[K`;
  };
  return `\u001b[H${lines.map(row).join("\r\n")}\u001b[J`;
}
