import { describe, expect, test } from "bun:test";

import { sanitizeValue, ThreadSanitizer } from "../../src/sessions/sanitize";

// Credential-shaped values are assembled at runtime so no literal fake
// secret sits in the repository for scanners to trip on.
const join = (...parts: string[]) => parts.join("");

const detections: Array<[kind: string, input: string, secret: string]> = [
  [
    "aws-key",
    `id ${join("AKIA", "GNOFIXTURE123456")} end`,
    join("AKIA", "GNOFIXTURE123456"),
  ],
  [
    "github-token",
    `t=${join("ghp_", "a".repeat(36))}`,
    join("ghp_", "a".repeat(36)),
  ],
  [
    "api-key",
    `key ${join("sk-proj-", "b".repeat(32))}`,
    join("sk-proj-", "b".repeat(32)),
  ],
  [
    "stripe-key",
    join("sk_live_", "c".repeat(24)),
    join("sk_live_", "c".repeat(24)),
  ],
  [
    "slack-token",
    join("xoxb-", "1234567890-abcdef"),
    join("xoxb-", "1234567890-abcdef"),
  ],
  ["google-key", join("AIza", "d".repeat(35)), join("AIza", "d".repeat(35))],
  [
    "jwt",
    join("eyJ", "e".repeat(20), ".eyJ", "f".repeat(20), ".", "g".repeat(20)),
    join("eyJ", "e".repeat(20)),
  ],
  [
    "bearer",
    "Authorization: Bearer abcdefghijklmnop0123456789",
    "abcdefghijklmnop0123456789",
  ],
  [
    "url-credentials",
    "postgres://admin:hunter2secret@db.local/app",
    "hunter2secret",
  ],
  ["assignment", 'api_key = "Zq9fixtureValue42"', "Zq9fixtureValue42"],
];

describe("format-based redaction", () => {
  for (const [kind, input, secret] of detections) {
    test(kind, () => {
      const output = sanitizeValue(input);
      expect(output).not.toContain(secret);
      expect(output).toContain(`[REDACTED:${kind}]`);
    });
  }

  test("private key blocks, including unterminated ones", () => {
    const block = join(
      "-----BEGIN RSA PRIVATE KEY-----\n",
      "MIIB".repeat(50),
      "\n-----END RSA PRIVATE KEY-----"
    );
    expect(sanitizeValue(`before ${block} after`)).toBe(
      "before [REDACTED:private-key] after"
    );
    const open = sanitizeValue(
      join("-----BEGIN PRIVATE KEY-----\n", "QUJD".repeat(20))
    );
    expect(open).toBe("[REDACTED:private-key]");
  });

  test("placeholders and ordinary prose are left alone", () => {
    const text = "password: redacted — the token budget is 512 tokens";
    expect(sanitizeValue(text)).toBe(text);
  });

  test("NUL and control characters are stripped", () => {
    expect(
      sanitizeValue(`a${String.fromCharCode(0)}b${String.fromCharCode(7)}c\n`)
    ).toBe("abc\n");
  });

  test("owner-configured literals are redacted exactly", () => {
    expect(
      sanitizeValue("host internal.placeholder.lan ok", {
        literals: ["internal.placeholder.lan"],
      })
    ).toBe("host [REDACTED:configured] ok");
  });
});

describe("thread-wide propagation", () => {
  test("a value detected in a later turn is redacted in earlier turns too", () => {
    const secret = join("Zq9", "propagatedValue77");
    const sanitizer = new ThreadSanitizer();
    const first = sanitizer.sanitize(`I pasted ${secret} earlier`);
    const second = sanitizer.sanitize(`password=${secret}`);
    expect(first).toContain(secret);
    expect(sanitizer.propagate(first)).not.toContain(secret);
    expect(second).not.toContain(secret);
  });
});

describe("adversarial inputs stay linear", () => {
  const cases: Array<[string, string]> = [
    ["near-miss api key prefixes", "sk-".repeat(400_000)],
    ["long token-like run", "a".repeat(2_000_000)],
    ["assignment keywords without values", "password=".repeat(200_000)],
    ["bearer without token", "Bearer ".repeat(250_000)],
    ["url credential fragments", "http://a:b".repeat(150_000)],
    ["jwt fragments", "eyJaaaaaaaaa.".repeat(150_000)],
  ];
  for (const [name, input] of cases) {
    test(name, () => {
      const started = performance.now();
      sanitizeValue(input);
      expect(performance.now() - started).toBeLessThan(2_000);
    });
  }
});
