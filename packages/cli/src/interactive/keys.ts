/**
 * Keys from a terminal in raw mode. One chunk of input can hold several keys (typed fast, or pasted), so it's split
 * into keys here: arrows and the other escape sequences, Enter, Backspace, Ctrl-C, and text, a character at a time.
 */
export type KeyName =
  | "up"
  | "down"
  | "left"
  | "right"
  | "pageup"
  | "pagedown"
  | "home"
  | "end"
  | "enter"
  | "escape"
  | "backspace"
  | "delete"
  | "tab"
  | "backtab"
  | "ctrl-c"
  | "ctrl-u"
  | "ctrl-d"
  | "char";

export interface Key {
  name: KeyName;
  /** The character typed, for `char`. */
  text?: string;
}

const SEQUENCES: Record<string, KeyName> = {
  "\u001b[A": "up",
  "\u001b[B": "down",
  "\u001b[C": "right",
  "\u001b[D": "left",
  "\u001bOA": "up",
  "\u001bOB": "down",
  "\u001bOC": "right",
  "\u001bOD": "left",
  "\u001b[5~": "pageup",
  "\u001b[6~": "pagedown",
  "\u001b[H": "home",
  "\u001b[F": "end",
  "\u001bOH": "home",
  "\u001bOF": "end",
  "\u001b[1~": "home",
  "\u001b[4~": "end",
  "\u001b[7~": "home",
  "\u001b[8~": "end",
  "\u001b[3~": "delete",
  "\u001b[Z": "backtab",
};

const CONTROLS: Record<string, KeyName> = {
  "\r": "enter",
  "\n": "enter",
  "\u007f": "backspace",
  "\b": "backspace",
  "\t": "tab",
  "\u0003": "ctrl-c",
  "\u0015": "ctrl-u",
  "\u0004": "ctrl-d",
};

/** A CSI or SS3 sequence at the start of `text`: ESC [ params final, or ESC O letter. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
const SEQUENCE = /^\u001b(?:\[[0-?]*[ -/]*[@-~]|O[A-Za-z])/;

export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let rest = data;
  while (rest.length > 0) {
    if (rest[0] === "\u001b") {
      const match = SEQUENCE.exec(rest);
      if (match) {
        const name = SEQUENCES[match[0]];
        // An unknown sequence (a function key, a mouse report) is dropped whole, never typed as text.
        if (name) keys.push({ name });
        rest = rest.slice(match[0].length);
        continue;
      }
      // A lone ESC, or ESC before a key (Alt+key): Escape, then whatever follows on its own.
      keys.push({ name: "escape" });
      rest = rest.slice(1);
      continue;
    }
    const [char = ""] = rest;
    // By code point, so an emoji is one character; CR LF (a pasted line end) is one Enter.
    const step = rest.startsWith("\r\n") ? 2 : (rest.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
    const text = rest.slice(0, step);
    rest = rest.slice(step);
    const control = CONTROLS[char];
    if (control) keys.push({ name: control });
    // Other control characters do nothing.
    else if (char >= " ") keys.push({ name: "char", text });
  }
  return keys;
}

/** A key as tests and the help line write it: "j", "enter", "ctrl-c". */
export function keyFrom(spec: string): Key {
  return spec.length === 1 || [...spec].length === 1 ? { name: "char", text: spec } : { name: spec as KeyName };
}
