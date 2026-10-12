/**
 * Memory input validation, the context fence, receipts, and record
 * materialization shared by remember and recall.
 *
 * Fencing limits (documented contract): the fence rejects (a) input whose
 * normalized-text hash matches a span hash on a presented recall receipt and
 * (b) input declaring `derivedFrom` gno:// origins. A paraphrase of recalled
 * text that carries neither is indistinguishable from an original fact and
 * cannot be fenced.
 *
 * @module src/core/memory-fence
 */

import type { Collection } from "../config/types";
import type { DocumentRow, StorePort } from "../store/types";
import type {
  MemoryDecision,
  MemoryFact,
  MemoryIdentity,
  MemoryRecallReceipt,
  MemoryServiceDeps,
  RememberInput,
} from "./memory-types";

import {
  invalidMemoryScopeReason,
  isMemorySubjectScope,
  MEMORY_MAX_FACT_BYTES,
  MEMORY_MAX_SCOPES,
  MEMORY_SUBJECT_SCOPE_PREFIX,
  normalizeMemoryRefs,
  normalizeMemoryScopes,
  validateMemoryRecord,
} from "./memory-record";
import {
  MEMORY_DEFAULT_LOCK_WAIT_MS,
  MEMORY_TOKEN_BYTES_ESTIMATE,
  MemoryError,
} from "./memory-types";

// ─────────────────────────────────────────────────────────────────────────────
// Service context helpers
// ─────────────────────────────────────────────────────────────────────────────

export function memoryNow(deps: MemoryServiceDeps): Date {
  return deps.now?.() ?? new Date();
}

export function memoryLockWaitMs(deps: MemoryServiceDeps): number {
  return deps.lockWaitMs ?? MEMORY_DEFAULT_LOCK_WAIT_MS;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function estimateTokens(text: string): number {
  return Math.ceil(utf8Bytes(text) / MEMORY_TOKEN_BYTES_ESTIMATE);
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

export function requireIdentity(input: MemoryIdentity): MemoryIdentity {
  const caller = input.caller?.trim();
  const session = input.session?.trim();
  if (!caller || !session) {
    throw new MemoryError(
      "MEMORY_IDENTITY_REQUIRED",
      "caller and session identity are required on every remember/recall call (receipts bind to them)."
    );
  }
  return { caller, session };
}

export function requireScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string")) {
    throw new MemoryError(
      "MEMORY_SCOPES_REQUIRED",
      "Explicit scopes are required; there is no implicit global scope."
    );
  }
  const normalized = normalizeMemoryScopes(scopes as string[]);
  if (normalized.length === 0) {
    throw new MemoryError(
      "MEMORY_SCOPES_REQUIRED",
      "Explicit scopes are required; there is no implicit global scope."
    );
  }
  if (normalized.length > MEMORY_MAX_SCOPES) {
    throw new MemoryError(
      "MEMORY_SCOPES_INVALID",
      `At most ${MEMORY_MAX_SCOPES} scopes per call.`
    );
  }
  for (const scope of normalized) {
    const reason = invalidMemoryScopeReason(scope);
    if (reason) throw new MemoryError("MEMORY_SCOPES_INVALID", reason);
  }
  return normalized;
}

/**
 * Caller scopes under gateway subject scoping: the `subject:` prefix is
 * server-owned, so a caller may not name one. Returns the caller scopes
 * retrieval filters by, the owner scope retrieval must also require when a
 * subject was asserted (both in the store query, before any limit), and the
 * scopes a write stores (caller scopes plus the owner scope).
 */
export function requireSubjectScopes(
  deps: MemoryServiceDeps,
  scopes: unknown
): {
  caller: string[];
  query: string[];
  owner?: string;
  write: string[];
} {
  const caller = requireScopes(scopes);
  const scoping = deps.subjectScoping;
  if (!scoping) return { caller, query: caller, write: caller };
  if (caller.some(isMemorySubjectScope)) {
    throw new MemoryError(
      "MEMORY_SCOPES_INVALID",
      `Scopes starting with "${MEMORY_SUBJECT_SCOPE_PREFIX}" are set by the server, not the caller.`
    );
  }
  const owner = scoping.ownerScope;
  if (!owner) return { caller, query: caller, write: caller };
  return {
    caller,
    query: caller,
    owner,
    write: requireScopes([...caller, owner]),
  };
}

export function requireRefs(refs: unknown): string[] {
  if (refs === undefined || refs === null) return [];
  if (!Array.isArray(refs)) {
    throw new MemoryError("MEMORY_REFS_INVALID", "refs must be a list.");
  }
  const result = normalizeMemoryRefs(refs);
  if ("reason" in result) {
    throw new MemoryError("MEMORY_REFS_INVALID", result.reason);
  }
  return result.refs;
}

export function requireManagedCollection(
  collections: readonly Collection[],
  name: string | undefined
): Collection {
  const wanted = name?.trim().toLowerCase();
  if (!wanted) {
    throw new MemoryError(
      "MEMORY_COLLECTION_REQUIRED",
      "A memory collection is required."
    );
  }
  const collection = collections.find(
    (candidate) => candidate.name.toLowerCase() === wanted
  );
  if (!collection) {
    throw new MemoryError(
      "MEMORY_COLLECTION_NOT_FOUND",
      `Collection not found: ${wanted}`
    );
  }
  if (collection.memoryManaged !== true) {
    throw new MemoryError(
      "MEMORY_COLLECTION_UNMANAGED",
      `Collection "${collection.name}" is not memory-managed. Set memoryManaged: true on it in the config to allow remember/recall; other collections stay read-only for memory.`
    );
  }
  return collection;
}

export function requireFactText(text: unknown): string {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new MemoryError("MEMORY_TEXT_REQUIRED", "Fact text is required.");
  }
  if (text.includes("\0")) {
    throw new MemoryError(
      "MEMORY_TEXT_REQUIRED",
      "Fact text must be text, not binary-like data."
    );
  }
  if (utf8Bytes(text) > MEMORY_MAX_FACT_BYTES) {
    throw new MemoryError(
      "MEMORY_TEXT_TOO_LARGE",
      `Fact text exceeds ${MEMORY_MAX_FACT_BYTES} bytes; remember stores single facts, not documents (use gno capture).`
    );
  }
  return text.trim();
}

export function requireDecision(decision: unknown): MemoryDecision | undefined {
  if (decision === undefined || decision === null) return undefined;
  if (decision === "add" || decision === "supersede") return decision;
  throw new MemoryError(
    "MEMORY_DECISION_INVALID",
    'decision must be omitted, "add", or "supersede".'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fence and receipts
// ─────────────────────────────────────────────────────────────────────────────

export function applyFence(input: RememberInput, spanHash: string): void {
  if (input.receipt?.spanHashes?.includes(spanHash)) {
    throw new MemoryError(
      "MEMORY_FENCED_REPLAY",
      "Rejected: this text replays a span from the presented recall receipt. Recalled memories are context, not new facts."
    );
  }
  const derived = (input.derivedFrom ?? []).filter((origin) =>
    origin.trim().startsWith("gno://")
  );
  if (derived.length > 0) {
    throw new MemoryError(
      "MEMORY_FENCED_DERIVED",
      `Rejected: input declares GNO-derived origin (${derived.join(", ")}). Facts derived from GNO's own output are not stored.`
    );
  }
}

/** Content-free receipt: identity, memory ids, span hashes, and a digest. */
export function buildRecallReceipt(input: {
  identity: MemoryIdentity;
  issuedAt: string;
  memoryIds: string[];
  spanHashes: string[];
}): MemoryRecallReceipt {
  const { identity, issuedAt, memoryIds, spanHashes } = input;
  return {
    caller: identity.caller,
    session: identity.session,
    issuedAt,
    memoryIds,
    spanHashes,
    digest: new Bun.CryptoHasher("sha256")
      .update(
        JSON.stringify({
          caller: identity.caller,
          session: identity.session,
          issuedAt,
          memoryIds,
          spanHashes,
        })
      )
      .digest("hex"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Record materialization
// ─────────────────────────────────────────────────────────────────────────────

export async function readFact(
  store: StorePort,
  doc: Pick<DocumentRow, "uri" | "docid" | "mirrorHash">
): Promise<MemoryFact | null> {
  if (!doc.mirrorHash) return null;
  const content = await store.getContent(doc.mirrorHash);
  if (!content.ok || content.value === null) return null;
  const validation = validateMemoryRecord(content.value);
  if (!validation.ok) return null;
  const { frontmatter, supersedes, text } = validation.record;
  return {
    uri: doc.uri,
    docid: doc.docid,
    recordId: frontmatter.recordId,
    text,
    scopes: frontmatter.scopes,
    caller: frontmatter.caller,
    session: frontmatter.session,
    createdAt: frontmatter.createdAt,
    contentHash: frontmatter.contentHash,
    supersedes,
    ...(frontmatter.source ? { source: frontmatter.source } : {}),
    ...(frontmatter.refs ? { refs: frontmatter.refs } : {}),
  };
}
