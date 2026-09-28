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

/** Finds likely secrets in one added line. Returns masked values only. */
export function findSecrets(line: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { name, pattern } of KNOWN_FORMATS) {
    const value = pattern.exec(line)?.[1];
    if (value && !PLACEHOLDER.test(value)) findings.push({ kind: name, masked: mask(value, true) });
  }
  const password = URL_CREDENTIALS.exec(line)?.[1];
  if (password && !PLACEHOLDER.test(password)) findings.push({ kind: "password in a URL", masked: mask(password) });
  if (findings.length === 0) {
    const assignment = ASSIGNMENT.exec(line);
    const [name, value] = [assignment?.[1], assignment?.[2]];
    if (name && value && !PLACEHOLDER.test(value) && looksRandom(value)) {
      findings.push({ kind: `hard-coded value for ${name}`, masked: mask(value) });
    }
  }
  return findings;
}
