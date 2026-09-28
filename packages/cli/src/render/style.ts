/** Terminal output shared by every renderer. Renderers return strings, so they're testable and pipe-safe. */
export interface RenderOptions {
  /** Terminal width in columns. */
  width: number;
  color: boolean;
}

const ANSI = { bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], cyan: [36, 39] } as const;
export type Style = keyof typeof ANSI;

export function paint(text: string, style: Style, color: boolean): string {
  if (!color) return text;
  const [open, close] = ANSI[style];
  return `\u001b[${open}m${text}\u001b[${close}m`;
}

/** Pads or cuts text to exactly `width` columns, ending cut text with "…". */
export function fit(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** Word-wraps text to `width`, prefixing every line with `indent`. Words longer than a line are broken. */
export function wrap(text: string, width: number, indent = ""): string[] {
  const room = Math.max(10, width - indent.length);
  const lines: string[] = [];
  let current = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > room) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(word.slice(0, room));
      word = word.slice(room);
    }
    if (!current) current = word;
    else if (current.length + 1 + word.length <= room) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.map((line) => `${indent}${line}`);
}

/** Colour only for a real terminal, and never when NO_COLOR is set (https://no-color.org). */
export function shouldColor(stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return stream.isTTY === true && env.TERM !== "dumb";
}
