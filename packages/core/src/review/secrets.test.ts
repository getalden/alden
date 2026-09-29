import { describe, expect, it } from "vitest";
import { findSecrets, mask, redactSecrets, shannonEntropy } from "./secrets.js";

// Fake credentials in the right shapes, assembled at runtime so this file never contains a full key-shaped string.
const fake = {
  aws: `AKIA${"IOSFODNN7EXAMPLE".slice(0, 16)}`,
  github: `ghp_${"a1B2c3D4e5".repeat(4)}`,
  stripe: `sk_live_${"4eC39HqLyjWDarjtT1zdp7dc"}`,
  anthropic: `sk-ant-api03-${"Zk3n9QpL2mX7vR4tY8wB"}`,
  slack: `xoxb-${"1234567890-abcdefghij"}`,
  jwt: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${"dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}`,
};

describe("findSecrets", () => {
  it.each([
    ["AWS access key", `aws_access_key_id = ${fake.aws}`],
    ["GitHub token", `const token = "${fake.github}";`],
    ["Stripe live key", `STRIPE_KEY=${fake.stripe}`],
    ["Anthropic API key", `client = Anthropic(api_key="${fake.anthropic}")`],
    ["Slack token", `'slack' => '${fake.slack}',`],
    ["JSON Web Token", `Authorization: Bearer ${fake.jwt}`],
    ["private key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
  ])("finds a %s", (kind, line) => {
    expect(findSecrets(line).map((f) => f.kind)).toContain(kind);
  });

  it("finds passwords in connection strings without revealing any of them", () => {
    const [finding] = findSecrets("DATABASE_URL=postgres://app:Xk92vLq7Rt@db.internal:5432/app");
    expect(finding).toEqual({ kind: "password in a URL", masked: "…(10 chars)" });
  });

  it("finds random-looking values assigned to secret-like names", () => {
    const [finding] = findSecrets(`$config['client_secret'] = 'f3Kd9Q2mZx81Lp0vW7yT';`);
    expect(finding?.kind).toBe("hard-coded value for client_secret");
    expect(finding?.masked).toBe("…(20 chars)");
  });

  it.each([
    ["an env lookup", "const key = process.env.STRIPE_SECRET_KEY;"],
    ["a placeholder", 'API_KEY="your-api-key-here"'],
    ["a test key", `stripe_key: "sk_test_${"4eC39HqLyjWDarjtT1zdp7dc"}"`],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} placeholder is the point of this case
    ["a template variable", "DATABASE_URL=postgres://app:${DB_PASSWORD}@db:5432/app"],
    ["an example password", "postgres://user:password@localhost/db"],
    ["an ordinary word", 'passwordResetRoute = "/account/password-reset"'],
    ["an author field", 'author = "Shelton Wilson 2026"'],
    ["a lookup of a secret by name", "token = get_secret('PAYMENTS_WEBHOOK_TOKEN')"],
  ])("ignores %s", (_label, line) => {
    expect(findSecrets(line)).toEqual([]);
  });

  it("never returns the secret itself", () => {
    for (const value of Object.values(fake)) {
      for (const finding of findSecrets(`secret = "${value}"`)) {
        expect(finding.masked).not.toContain(value.slice(4, 12));
      }
    }
  });
});

describe("mask and entropy", () => {
  it("keeps only a known public prefix", () => {
    expect(mask("ghp_abcdefgh", true)).toBe("ghp_…(12 chars)");
    expect(mask("hunter2hunter2")).toBe("…(14 chars)");
  });

  it("scores random strings higher than words", () => {
    expect(shannonEntropy("f3Kd9Q2mZx81Lp0vW7yT")).toBeGreaterThan(4);
    expect(shannonEntropy("aaaaaaaaaaaa")).toBe(0);
  });
});

describe("redactSecrets", () => {
  // Key material assembled at runtime, like the fakes above.
  const keyLines = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj"];

  it("replaces every known-format secret, keeping the kind and a masked hint", () => {
    const { text, redacted } = redactSecrets(`   12 + const a = "${fake.github}"; const b = "${fake.github}";`);
    expect(text).not.toContain(fake.github);
    expect(text).toContain("[redacted GitHub token, ghp_…(44 chars)]");
    expect(redacted).toBe(2);
  });

  it("redacts connection-string passwords and secret-looking assignments", () => {
    const { text } = redactSecrets(
      `DATABASE_URL=postgres://app:Xk92vLq7Rt@db.internal/app\n$config['client_secret'] = 'f3Kd9Q2mZx81Lp0vW7yT';`,
    );
    expect(text).not.toContain("Xk92vLq7Rt");
    expect(text).not.toContain("f3Kd9Q2mZx81Lp0vW7yT");
    expect(text).toContain("postgres://app:[redacted password in a URL, …(10 chars)]@db.internal/app");
  });

  it("redacts a private key's body across lines, keeping its BEGIN and END lines", () => {
    const diff = [
      "    3 + -----BEGIN RSA PRIVATE KEY-----",
      ...keyLines.map((l, i) => `${String(4 + i).padStart(5)} + ${l}`),
      "    6 + -----END RSA PRIVATE KEY-----",
      "    7 + const handleSomethingVeryLong = 1;",
    ].join("\n");
    const { text, redacted } = redactSecrets(diff);
    for (const l of keyLines) expect(text).not.toContain(l);
    expect(text).toContain("    4 + [redacted private key]");
    expect(text).toContain("-----END RSA PRIVATE KEY-----");
    expect(text).toContain("handleSomethingVeryLong");
    expect(redacted).toBe(1);
  });

  it("redacts a key written on one line with escaped newlines", () => {
    const { text } = redactSecrets(
      `KEY="-----BEGIN PRIVATE KEY-----\\n${keyLines.join("\\n")}\\n-----END PRIVATE KEY-----"`,
    );
    for (const l of keyLines) expect(text).not.toContain(l.slice(1));
    expect(text).toContain("-----END PRIVATE KEY-----");
  });

  it("stops a key with no END line at the next file in a prompt", () => {
    const { text } = redactSecrets(
      [
        "    1 + -----BEGIN PRIVATE KEY-----",
        `    2 + ${keyLines[0]}`,
        "### src/next.ts (added, +1/-0)",
        "    1 + const aVeryLongIdentifierName = 1;",
      ].join("\n"),
    );
    expect(text).not.toContain(keyLines[0]);
    expect(text).toContain("aVeryLongIdentifierName");
  });

  it("leaves ordinary code alone", () => {
    const code = 'const key = process.env.STRIPE_SECRET_KEY;\nAPI_KEY="your-api-key-here"';
    expect(redactSecrets(code)).toEqual({ text: code, redacted: 0 });
  });
});
