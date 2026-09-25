/**
 * Secret redaction applied before any session content is persisted.
 *
 * Detection is format-based (well-known credential shapes) plus
 * owner-configured exact literals. Every pattern uses bounded, non-nested
 * quantifiers so scanning stays linear in the input length; inputs are also
 * bounded per turn by the caller. Redaction is best effort: it does not
 * promise to find every secret or personal datum.
 *
 * A value detected anywhere in a thread is propagated: later exact
 * occurrences of the same value in that thread are redacted too, even where
 * the surrounding shape no longer matches.
 *
 * @module src/sessions/sanitize
 */

/** Bumped whenever a rule changes; stale archives are rescanned on import. */
export const SESSION_REDACTION_VERSION = 1;

/**
 * Identity of the effective redaction policy: the rule version plus the
 * owner's configured literals. Any change re-renders or rescans archives.
 */
export function redactionStamp(policy: RedactionPolicy = {}): string {
  const literals = [...new Set(policy.literals ?? [])].sort();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(literals));
  return `${SESSION_REDACTION_VERSION}:${hasher.digest("hex").slice(0, 16)}`;
}

const MAX_PROPAGATED_VALUES = 256;
const MIN_PROPAGATED_LENGTH = 8;
const PRIVATE_KEY_WINDOW = 16 * 1024;
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/;

interface Rule {
  kind: string;
  pattern: RegExp;
  /** Capture group holding the secret; 0 means the whole match. */
  group: number;
}

// Every quantifier is bounded; no quantified group contains another quantifier.
const RULES: readonly Rule[] = [
  { kind: "aws-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, group: 0 },
  {
    kind: "github-token",
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{22,255})/g,
    group: 0,
  },
  {
    kind: "api-key",
    pattern: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,512}/g,
    group: 0,
  },
  {
    kind: "stripe-key",
    pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,256}/g,
    group: 0,
  },
  {
    kind: "slack-token",
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,256}/g,
    group: 0,
  },
  { kind: "google-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g, group: 0 },
  {
    kind: "jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,4096}/g,
    group: 0,
  },
  {
    kind: "bearer",
    pattern: /\b(?:Bearer|Token)[ \t]{1,8}([A-Za-z0-9._~+/=-]{16,4096})/g,
    group: 1,
  },
  {
    kind: "url-credentials",
    pattern: /\b[a-z][a-z0-9+.-]{1,16}:\/\/[^\s:@/]{1,256}:([^\s@/]{1,256})@/gi,
    group: 1,
  },
  {
    kind: "assignment",
    pattern:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|token)["']?[ \t]{0,4}[:=][ \t]{0,4}["']?([^\s"'`,;]{6,512})/gi,
    group: 1,
  },
];

const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g"
);

const PLACEHOLDER_VALUES = new Set([
  "redacted",
  "changeme",
  "password",
  "example",
  "xxxxxx",
  "********",
  "<redacted>",
]);

const marker = (kind: string): string => `[REDACTED:${kind}]`;

export interface RedactionPolicy {
  /** Owner-configured exact literals (e.g. a known internal hostname or key). */
  literals?: readonly string[];
}

/**
 * Per-thread sanitizer. Holds the values detected so far so later turns of
 * the same thread redact them even out of their original shape.
 */
export class ThreadSanitizer {
  private readonly literals: string[];
  private readonly detected = new Set<string>();
  redactions = 0;

  constructor(policy: RedactionPolicy = {}) {
    this.literals = [...new Set(policy.literals ?? [])]
      .filter((value) => value.length >= 4)
      .sort((left, right) => right.length - left.length);
  }

  /** Values detected so far (bounded); used for the propagation pass. */
  get detectedValues(): readonly string[] {
    return [...this.detected];
  }

  private remember(value: string): void {
    if (
      value.length >= MIN_PROPAGATED_LENGTH &&
      this.detected.size < MAX_PROPAGATED_VALUES &&
      !PLACEHOLDER_VALUES.has(value.toLowerCase())
    ) {
      this.detected.add(value);
    }
  }

  private replaceLiteral(text: string, literal: string, kind: string): string {
    if (!text.includes(literal)) return text;
    const parts = text.split(literal);
    this.redactions += parts.length - 1;
    return parts.join(marker(kind));
  }

  private redactPrivateKeys(text: string): string {
    if (!text.includes("PRIVATE KEY-----")) return text;
    let output = "";
    let cursor = 0;
    PRIVATE_KEY_BEGIN.lastIndex = 0;
    for (;;) {
      const begin = PRIVATE_KEY_BEGIN.exec(text);
      if (!begin) break;
      const window = text.slice(begin.index, begin.index + PRIVATE_KEY_WINDOW);
      const end = PRIVATE_KEY_END.exec(window);
      // An unterminated block is redacted to the end of its window.
      const stop = end
        ? begin.index + end.index + end[0].length
        : Math.min(text.length, begin.index + PRIVATE_KEY_WINDOW);
      output += `${text.slice(cursor, begin.index)}${marker("private-key")}`;
      this.redactions += 1;
      cursor = stop;
      PRIVATE_KEY_BEGIN.lastIndex = stop;
    }
    return output + text.slice(cursor);
  }

  /** Sanitize one field. Safe for titles, labels and metadata as well as bodies. */
  sanitize(input: string): string {
    let text = input.replace(CONTROL_CHARS, "");
    text = this.redactPrivateKeys(text);
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      text = text.replace(
        rule.pattern,
        (match: string, ...groups: unknown[]) => {
          const secret =
            rule.group === 0 ? match : (groups[rule.group - 1] as string);
          if (!secret || PLACEHOLDER_VALUES.has(secret.toLowerCase())) {
            return match;
          }
          if (secret.startsWith("[REDACTED:")) return match;
          this.remember(secret);
          this.redactions += 1;
          return rule.group === 0
            ? marker(rule.kind)
            : match.replace(secret, marker(rule.kind));
        }
      );
    }
    for (const literal of this.literals) {
      text = this.replaceLiteral(text, literal, "configured");
    }
    return this.propagate(text);
  }

  /**
   * Redact exact occurrences of every value detected so far. Run over the
   * whole thread after the first pass so earlier turns are covered too.
   */
  propagate(text: string): string {
    let output = text;
    for (const value of this.detected) {
      output = this.replaceLiteral(output, value, "propagated");
    }
    return output;
  }
}

/** Sanitize a single standalone value with a fresh per-call sanitizer. */
export function sanitizeValue(
  value: string,
  policy: RedactionPolicy = {}
): string {
  return new ThreadSanitizer(policy).sanitize(value);
}
