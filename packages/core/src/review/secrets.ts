/** Formats with a recognisable prefix. These are near-certain when they match. */
const KNOWN_FORMATS: { name: string; pattern: RegExp }[] = [
  { name: "AWS access key", pattern: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/ },
  { name: "GitHub token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,})\b/ },
  { name: "GitHub fine-grained token", pattern: /\b(github_pat_[A-Za-z0-9_]{60,})\b/ },
  { name: "Slack token", pattern: /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/ },
  { name: "Stripe live key", pattern: /\b((?:sk|rk)_live_[A-Za-z0-9]{20,})\b/ },
  { name: "Google API key", pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/ },
  { name: "Anthropic API key", pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/ },
  { name: "OpenAI API key", pattern: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/ },
  { name: "Resend API key", pattern: /\b(re_[A-Za-z0-9]{8}_[A-Za-z0-9]{16,})\b/ },
  { name: "private key", pattern: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----)/ },
  { name: "JSON Web Token", pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/ },
];

/** Password in a connection string: postgres://user:PASSWORD@host. Its first characters are secret too. */
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{6,})@/i;

/**
 * A literal assigned to something named like a secret: `API_KEY = "..."`, `'password' => '...'`, `token: "..."`,
 * `$config['client_secret'] = '...'`.
 */
const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:secret|passw(?:or)?d|pwd|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_]*)['"]?\]?\s*(?:=>|:=|=|:)\s*['"]([^'"\s]{12,})['"]/i;

/** Values that are obviously not real secrets. */
const PLACEHOLDER =
  /^(?:x+|\*+|\.+|<[^>]+>|\$\{[^}]+\}|%[^%]+%|\{\{[^}]+\}\}|your[-_]?.*|change[-_]?me.*|example.*|test.*|dummy.*|fake.*|placeholder.*|redacted.*|pass(?:word)?|secret|pw|(?:sk|pk)_test_.*|null|none|undefined|true|false)$/i;

/** Bits of entropy per character. Real keys sit well above ordinary words and identifiers. */
export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const looksRandom = (value: string) =>
  shannonEntropy(value) >= 3.5 && /[0-9]/.test(value) && /[A-Za-z]/.test(value) && !/\s/.test(value);

/**
 * Shows enough to recognise a value without revealing it. Known formats keep their public prefix ("ghp_…(40 chars)");
 * anything else shows only its length.
 */
export function mask(value: string, showPrefix = false): string {
  return `${showPrefix ? value.slice(0, 4) : ""}…(${value.length} chars)`;
}

export interface SecretFinding {
  kind: string;
  masked: string;
}

interface SecretMatch extends SecretFinding {
  value: string;
}

const everywhere = (pattern: RegExp) => new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);

/** Every likely secret in one line, with its raw value. `all` finds repeats too; otherwise the first per kind. */
function matchSecrets(line: string, all: boolean): SecretMatch[] {
  const found: SecretMatch[] = [];
  const add = (kind: string, value: string | undefined, showPrefix: boolean) => {
    if (value && !PLACEHOLDER.test(value)) found.push({ kind, value, masked: mask(value, showPrefix) });
  };
  for (const { name, pattern } of KNOWN_FORMATS) {
    if (all) for (const match of line.matchAll(everywhere(pattern))) add(name, match[1], true);
    else add(name, pattern.exec(line)?.[1], true);
  }
  add("password in a URL", URL_CREDENTIALS.exec(line)?.[1], false);
  // Assignments are the weakest signal, so they only count when nothing stronger matched.
  if (found.length === 0) {
    const assignment = ASSIGNMENT.exec(line);
    const [name, value] = [assignment?.[1], assignment?.[2]];
    if (name && value && looksRandom(value)) add(`hard-coded value for ${name}`, value, false);
  }
  return found;
}

/** Finds likely secrets in one added line. Returns masked values only. */
export function findSecrets(line: string): SecretFinding[] {
  return matchSecrets(line, false).map(({ kind, masked }) => ({ kind, masked }));
}

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;
/** The body of a PEM key: long base64 runs. Line numbers and diff markers are too short to match. */
const KEY_BODY = /[A-Za-z0-9+/=]{16,}/g;
const KEY_PLACEHOLDER = "[redacted private key]";

/**
 * Text with every likely secret replaced by a masked placeholder, for anything that leaves the machine (the model's
 * prompt). Works on whole prompts: diff lines, descriptions and code snippets. Private keys are redacted from their
 * BEGIN line to their END line, including keys written on one line with escaped newlines.
 */
export function redactSecrets(text: string): { text: string; redacted: number } {
  let redacted = 0;
  let inKey = false;
  const lines = text.split("\n").map((line) => {
    let out = line;
    // A key with no END line (cut off by the diff) stops at the next file or hunk in a prompt.
    if (/^(### |@@ )/.test(out)) inKey = false;
    const begin = PRIVATE_KEY_BEGIN.exec(out);
    if (begin || inKey) {
      if (begin) redacted++;
      // Keep the BEGIN and END lines readable; only the key material between them goes.
      const from = begin ? begin.index + begin[0].length : 0;
      const end = PRIVATE_KEY_END.exec(out.slice(from));
      const to = end ? from + end.index : out.length;
      out = out.slice(0, from) + out.slice(from, to).replace(KEY_BODY, KEY_PLACEHOLDER) + out.slice(to);
      inKey = !end;
    }
    for (const match of matchSecrets(out, true)) {
      if (match.kind === "private key") continue;
      // Repeats of a value were all replaced by its first match.
      const parts = out.split(match.value);
      redacted += parts.length - 1;
      out = parts.join(`[redacted ${match.kind}, ${match.masked}]`);
    }
    return out;
  });
  return { text: lines.join("\n"), redacted };
}
