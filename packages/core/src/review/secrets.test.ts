import { describe, expect, it } from "vitest";
import { findSecrets, mask, shannonEntropy } from "./secrets.js";

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
