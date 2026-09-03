/**
 * Managed memory record contract: frontmatter shape, scope normalization,
 * text normalization, similarity primitives, and the malformed-file validator.
 *
 * One fact per markdown file. Files are canonical; every derived row (scopes,
 * supersedes edges, FTS) is rebuilt from the file by ingestion.
 *
 * @module src/core/memory-record
 */

export const MEMORY_MAX_SCOPES = 8;
export const MEMORY_MAX_SCOPE_CHARS = 64;
export const MEMORY_MAX_FACT_BYTES = 4096;
export const MEMORY_SUPERSEDES_EDGE = "supersedes";
export const MEMORY_FRONTMATTER_KEY = "memory";
export const MEMORY_RECORD_ID_PREFIX = "mem-";

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n|$)/;
const SCOPE_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:/@-]*$/u;
const RECORD_ID_PATTERN = /^mem-[0-9a-f]{16}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const WHITESPACE_RUN = /\s+/g;
const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;
const URI_PREFIX = "gno://";

export type MemoryDiagnosticCode =
  | "MEMORY_FRONTMATTER_MISSING"
  | "MEMORY_FRONTMATTER_INVALID"
  | "MEMORY_RECORD_ID_INVALID"
  | "MEMORY_SCOPES_INVALID"
  | "MEMORY_SCOPES_EMPTY"
  | "MEMORY_IDENTITY_MISSING"
  | "MEMORY_CREATED_AT_INVALID"
  | "MEMORY_CONTENT_HASH_INVALID"
  | "MEMORY_CONTENT_HASH_MISMATCH"
  | "MEMORY_BODY_EMPTY"
  | "MEMORY_SUPERSEDES_INVALID";

export interface MemoryDiagnostic {
  code: MemoryDiagnosticCode;
  message: string;
}

/** The frontmatter block every managed memory record must carry. */
export interface MemoryRecordFrontmatter {
  recordId: string;
  scopes: string[];
  caller: string;
  session: string;
  createdAt: string;
  contentHash: string;
  /** Free-text evidence for the fact (where it came from), when given. */
  source?: string;
}

export interface ParsedMemoryRecord {
  frontmatter: MemoryRecordFrontmatter;
  /** gno:// URIs of predecessors this record supersedes (may be empty). */
  supersedes: string[];
  /** Fact text with frontmatter stripped and trailing whitespace trimmed. */
  text: string;
}

export type MemoryRecordValidation =
  | { ok: true; record: ParsedMemoryRecord }
  | { ok: false; diagnostics: MemoryDiagnostic[] };

// ─────────────────────────────────────────────────────────────────────────────
// Normalization primitives
// ─────────────────────────────────────────────────────────────────────────────

/** Trim, lowercase, NFC, dedupe; order-preserving on first occurrence. */
export function normalizeMemoryScopes(scopes: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of scopes) {
    const scope = raw.normalize("NFC").trim().toLowerCase();
    if (scope.length === 0 || seen.has(scope)) continue;
    seen.add(scope);
    normalized.push(scope);
  }
  return normalized;
}

/** Validation message for a normalized scope, or null when acceptable. */
export function invalidMemoryScopeReason(scope: string): string | null {
  if (scope.length > MEMORY_MAX_SCOPE_CHARS) {
    return `scope "${scope}" exceeds ${MEMORY_MAX_SCOPE_CHARS} characters`;
  }
  if (!SCOPE_PATTERN.test(scope)) {
    return `scope "${scope}" must start with a letter or digit and contain only letters, digits, . _ : / @ -`;
  }
  return null;
}

/** Any-intersection visibility: a fact is visible when scopes overlap. */
export function memoryScopesIntersect(
  factScopes: readonly string[],
  requested: readonly string[]
): boolean {
  const wanted = new Set(normalizeMemoryScopes(requested));
  return normalizeMemoryScopes(factScopes).some((scope) => wanted.has(scope));
}

/** Trim, collapse whitespace runs, NFC. Exact-duplicate identity. */
export function normalizeMemoryText(text: string): string {
  return text.normalize("NFC").replace(WHITESPACE_RUN, " ").trim();
}

export function hashMemoryText(text: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(normalizeMemoryText(text))
    .digest("hex");
}

/** Lowercased letter/digit tokens, deduplicated. Corpus-independent. */
export function memoryTokenSet(text: string): Set<string> {
  return new Set(
    normalizeMemoryText(text)
      .toLowerCase()
      .split(TOKEN_SPLIT)
      .filter((token) => token.length > 0)
  );
}

/** Jaccard similarity over normalized token sets (lexical likely-match). */
export function memoryJaccard(left: string, right: string): number {
  const a = memoryTokenSet(left);
  const b = memoryTokenSet(right);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function memoryCosine(
  left: readonly number[],
  right: readonly number[]
): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    normLeft += a * a;
    normRight += b * b;
  }
  if (normLeft === 0 || normRight === 0) return 0;
  return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight));
}

// ─────────────────────────────────────────────────────────────────────────────
// Record identity and serialization
// ─────────────────────────────────────────────────────────────────────────────

export function buildMemoryRecordId(input: {
  contentHash: string;
  createdAt: string;
  caller: string;
  session: string;
}): string {
  const digest = new Bun.CryptoHasher("sha256")
    .update(
      [input.contentHash, input.createdAt, input.caller, input.session].join(
        "\n"
      )
    )
    .digest("hex");
  return `${MEMORY_RECORD_ID_PREFIX}${digest.slice(0, 16)}`;
}

/** Deterministic relative path: one fact file per record. */
export function buildMemoryRecordRelPath(
  frontmatter: Pick<MemoryRecordFrontmatter, "recordId" | "createdAt">
): string {
  return `facts/${frontmatter.createdAt.slice(0, 10)}/${frontmatter.recordId}.md`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** Serialize the canonical fact file content. */
export function serializeMemoryRecord(input: {
  frontmatter: MemoryRecordFrontmatter;
  supersedes: string[];
  text: string;
}): string {
  const { frontmatter } = input;
  const text = input.text.trim();
  const title = normalizeMemoryText(text).slice(0, 80);
  const lines = [
    "---",
    `title: ${yamlString(title)}`,
    `${MEMORY_FRONTMATTER_KEY}:`,
    `  recordId: ${yamlString(frontmatter.recordId)}`,
    `  scopes: [${frontmatter.scopes.map(yamlString).join(", ")}]`,
    `  caller: ${yamlString(frontmatter.caller)}`,
    `  session: ${yamlString(frontmatter.session)}`,
    `  createdAt: ${yamlString(frontmatter.createdAt)}`,
    `  contentHash: ${yamlString(frontmatter.contentHash)}`,
  ];
  if (frontmatter.source) {
    lines.push(`  source: ${yamlString(frontmatter.source)}`);
  }
  if (input.supersedes.length > 0) {
    lines.push("relations:", `  ${MEMORY_SUPERSEDES_EDGE}:`);
    for (const uri of input.supersedes) {
      lines.push(`    - ${yamlString(uri)}`);
    }
  }
  lines.push("---", "", text, "");
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Validator
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readSupersedes(
  relations: unknown,
  diagnostics: MemoryDiagnostic[]
): string[] {
  if (relations === undefined || relations === null) return [];
  if (!isRecord(relations)) {
    diagnostics.push({
      code: "MEMORY_SUPERSEDES_INVALID",
      message: "relations must be a mapping",
    });
    return [];
  }
  const targets = relations[MEMORY_SUPERSEDES_EDGE];
  if (targets === undefined || targets === null) return [];
  const list = Array.isArray(targets) ? targets : [targets];
  const uris: string[] = [];
  for (const target of list) {
    if (typeof target !== "string" || !target.startsWith(URI_PREFIX)) {
      diagnostics.push({
        code: "MEMORY_SUPERSEDES_INVALID",
        message: `relations.${MEMORY_SUPERSEDES_EDGE} entries must be gno:// URIs`,
      });
      return [];
    }
    uris.push(target);
  }
  return uris;
}

/**
 * Validate one file as a managed memory record. Returns every diagnostic
 * found (never just the first) so status/audit can name them all.
 */
export function validateMemoryRecord(content: string): MemoryRecordValidation {
  const diagnostics: MemoryDiagnostic[] = [];
  const match = FRONTMATTER_REGEX.exec(content);
  if (!match) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "MEMORY_FRONTMATTER_MISSING",
          message: "memory record has no frontmatter block",
        },
      ],
    };
  }
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(match[1] ?? "");
  } catch (cause) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "MEMORY_FRONTMATTER_INVALID",
          message: `frontmatter is not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      ],
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "MEMORY_FRONTMATTER_INVALID",
          message: "frontmatter must be a mapping",
        },
      ],
    };
  }
  const memory = parsed[MEMORY_FRONTMATTER_KEY];
  if (!isRecord(memory)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "MEMORY_FRONTMATTER_MISSING",
          message: `frontmatter has no "${MEMORY_FRONTMATTER_KEY}" mapping`,
        },
      ],
    };
  }

  const recordId = memory.recordId;
  if (typeof recordId !== "string" || !RECORD_ID_PATTERN.test(recordId)) {
    diagnostics.push({
      code: "MEMORY_RECORD_ID_INVALID",
      message: "memory.recordId must match mem-<16 hex chars>",
    });
  }

  let scopes: string[] = [];
  const rawScopes = memory.scopes;
  if (!Array.isArray(rawScopes)) {
    diagnostics.push({
      code: "MEMORY_SCOPES_INVALID",
      message: "memory.scopes must be a list of strings",
    });
  } else if (rawScopes.some((scope) => typeof scope !== "string")) {
    diagnostics.push({
      code: "MEMORY_SCOPES_INVALID",
      message: "memory.scopes entries must be strings",
    });
  } else {
    scopes = normalizeMemoryScopes(rawScopes as string[]);
    const invalid = scopes.map(invalidMemoryScopeReason).find(Boolean);
    if (invalid) {
      diagnostics.push({ code: "MEMORY_SCOPES_INVALID", message: invalid });
    } else if (scopes.length > MEMORY_MAX_SCOPES) {
      diagnostics.push({
        code: "MEMORY_SCOPES_INVALID",
        message: `memory.scopes allows at most ${MEMORY_MAX_SCOPES} scopes`,
      });
    } else if (scopes.length === 0) {
      diagnostics.push({
        code: "MEMORY_SCOPES_EMPTY",
        message: "memory.scopes must name at least one scope",
      });
    }
  }

  if (!nonEmptyString(memory.caller) || !nonEmptyString(memory.session)) {
    diagnostics.push({
      code: "MEMORY_IDENTITY_MISSING",
      message: "memory.caller and memory.session are required",
    });
  }

  const createdAt = memory.createdAt;
  if (
    typeof createdAt !== "string" ||
    Number.isNaN(new Date(createdAt).getTime())
  ) {
    diagnostics.push({
      code: "MEMORY_CREATED_AT_INVALID",
      message: "memory.createdAt must be an ISO-8601 timestamp",
    });
  }

  const text = content.slice(match[0].length).trim();
  if (text.length === 0) {
    diagnostics.push({
      code: "MEMORY_BODY_EMPTY",
      message: "memory record body (the fact text) is empty",
    });
  }

  const contentHash = memory.contentHash;
  if (typeof contentHash !== "string" || !SHA256_PATTERN.test(contentHash)) {
    diagnostics.push({
      code: "MEMORY_CONTENT_HASH_INVALID",
      message: "memory.contentHash must be a lowercase sha256 hex digest",
    });
  } else if (text.length > 0 && hashMemoryText(text) !== contentHash) {
    diagnostics.push({
      code: "MEMORY_CONTENT_HASH_MISMATCH",
      message: "memory.contentHash does not match the fact text",
    });
  }

  const supersedes = readSupersedes(parsed.relations, diagnostics);
  // Optional evidence: kept only when it is a non-empty string.
  const source = nonEmptyString(memory.source) ? memory.source.trim() : null;

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return {
    ok: true,
    record: {
      frontmatter: {
        recordId: recordId as string,
        scopes,
        caller: (memory.caller as string).trim(),
        session: (memory.session as string).trim(),
        createdAt: new Date(createdAt as string).toISOString(),
        contentHash: contentHash as string,
        ...(source ? { source } : {}),
      },
      supersedes,
      text,
    },
  };
}

/** Indexed scopes for a file: the validated set, or none when malformed. */
export function extractMemoryScopes(content: string): string[] {
  const validation = validateMemoryRecord(content);
  return validation.ok ? validation.record.frontmatter.scopes : [];
}

/** Whether the file declares the managed-memory contract at all. */
export function declaresMemoryRecord(content: string): boolean {
  const match = FRONTMATTER_REGEX.exec(content);
  if (!match) return false;
  try {
    const parsed = Bun.YAML.parse(match[1] ?? "");
    return isRecord(parsed) && isRecord(parsed[MEMORY_FRONTMATTER_KEY]);
  } catch {
    return /^memory:\s*$/mu.test(match[1] ?? "");
  }
}
