/**
 * `remember()`: candidate matching, the add path, and supersession.
 *
 * Owns the shared write lease for every write (single acquisition point, no
 * nesting — a caller that already holds the lease deadlocks/fails fast).
 *
 * @module src/core/memory-remember
 */

// node:fs/promises for mkdir (no Bun equivalent for recursive dir creation)
import { mkdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { dirname, join } from "node:path";

import type { DocumentRow, FtsResult } from "../store/types";
import type {
  MemoryCandidate,
  MemoryCandidateMatch,
  MemoryFact,
  MemoryMatchDiagnostics,
  MemoryServiceDeps,
  MemorySyncState,
  RememberInput,
  RememberResult,
} from "./memory-types";

import { defaultSyncService, withContentTypeRules } from "../ingestion";
import { withWriteLock } from "./file-lock";
import { atomicCreate } from "./file-ops";
import {
  applyFence,
  compareCodeUnits,
  memoryLockWaitMs,
  memoryNow,
  readFact,
  requireDecision,
  requireFactText,
  requireIdentity,
  requireManagedCollection,
  requireScopes,
} from "./memory-fence";
import {
  buildMemoryRecordId,
  buildMemoryRecordRelPath,
  hashMemoryText,
  MEMORY_SUPERSEDES_EDGE,
  memoryCosine,
  memoryJaccard,
  normalizeMemoryText,
  serializeMemoryRecord,
  type MemoryRecordFrontmatter,
} from "./memory-record";
import {
  MEMORY_CANDIDATE_POOL,
  MEMORY_LEXICAL_LIKELY_THRESHOLD,
  MEMORY_SEMANTIC_LIKELY_THRESHOLD,
  MemoryError,
} from "./memory-types";

export interface CandidateQuery {
  text: string;
  collection: string;
  scopes: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Candidate pool: BM25 top-16 (any-term) within the scope intersection,
 * current facts only, materialized as records.
 */
async function loadCandidatePool(
  deps: MemoryServiceDeps,
  input: CandidateQuery
): Promise<MemoryFact[]> {
  const { store } = deps;
  const ftsResult = await store.searchFts(normalizeMemoryText(input.text), {
    limit: MEMORY_CANDIDATE_POOL,
    collection: input.collection,
    memoryScopesAny: input.scopes,
    excludeSuperseded: true,
    anyTerm: true,
    snippet: false,
  });
  // INVALID_INPUT means the text has no searchable terms: an empty pool.
  if (!ftsResult.ok && ftsResult.error.code !== "INVALID_INPUT") {
    throw new MemoryError("MEMORY_QUERY_FAILED", ftsResult.error.message);
  }
  const rows: FtsResult[] = ftsResult.ok ? ftsResult.value : [];
  const seen = new Set<string>();
  const facts: MemoryFact[] = [];
  for (const row of rows) {
    if (!row.uri || !row.docid || seen.has(row.uri)) continue;
    seen.add(row.uri);
    const fact = await readFact(store, {
      uri: row.uri,
      docid: row.docid,
      mirrorHash: row.mirrorHash,
    });
    if (fact) facts.push(fact);
  }
  return facts;
}

/**
 * Exact-duplicate lookup (same normalized-text hash) in the candidate pool.
 * Re-run under the write lease so two concurrent adds of the same text
 * cannot both write.
 */
async function findExactCurrent(
  deps: MemoryServiceDeps,
  input: CandidateQuery & { contentHash: string }
): Promise<MemoryFact | null> {
  const pool = await loadCandidatePool(deps, input);
  return pool.find((fact) => fact.contentHash === input.contentHash) ?? null;
}

/**
 * Candidates with similarity: cosine when semantic is ready, else
 * normalized-token Jaccard. Ordered by similarity desc, ties by recordId.
 */
export async function findMemoryCandidates(
  deps: MemoryServiceDeps,
  input: CandidateQuery
): Promise<{
  candidates: MemoryCandidate[];
  matching: MemoryMatchDiagnostics;
}> {
  const normalizedText = normalizeMemoryText(input.text);
  const facts = await loadCandidatePool(deps, input);

  const incomingHash = hashMemoryText(input.text);
  let matching: MemoryMatchDiagnostics = {
    mode: "lexical",
    threshold: MEMORY_LEXICAL_LIKELY_THRESHOLD,
  };
  let similarities: number[] | null = null;
  const embedPort = deps.embedPort ?? null;
  if (embedPort && facts.length > 0) {
    const embedded = await embedPort.embedBatch([
      normalizedText,
      ...facts.map((fact) => normalizeMemoryText(fact.text)),
    ]);
    if (embedded.ok && embedded.value.length === facts.length + 1) {
      const [query, ...vectors] = embedded.value;
      similarities = vectors.map((vector) => memoryCosine(query ?? [], vector));
      matching = {
        mode: "semantic",
        threshold: MEMORY_SEMANTIC_LIKELY_THRESHOLD,
      };
    } else {
      matching.semanticUnavailable = embedded.ok
        ? "embedding batch returned an unexpected shape"
        : embedded.error.message;
    }
  } else if (!embedPort) {
    matching.semanticUnavailable = "no embedding model available";
  }

  const candidates: MemoryCandidate[] = facts.map((fact, index) => {
    const exact = fact.contentHash === incomingHash;
    const similarity = exact
      ? 1
      : (similarities?.[index] ?? memoryJaccard(input.text, fact.text));
    const match: MemoryCandidateMatch = exact
      ? "exact"
      : similarity >= matching.threshold
        ? "likely"
        : "weak";
    return { ...fact, similarity, match };
  });
  candidates.sort(
    (left, right) =>
      right.similarity - left.similarity ||
      compareCodeUnits(left.recordId, right.recordId)
  );
  return { candidates, matching };
}

// ─────────────────────────────────────────────────────────────────────────────
// Supersession checks (under the lease)
// ─────────────────────────────────────────────────────────────────────────────

/** Under the lease: predecessor exists, hash matches, no successor yet. */
async function verifyPredecessor(
  deps: MemoryServiceDeps,
  collection: string,
  predecessorUri: string,
  predecessorHash: string
): Promise<string> {
  const { store } = deps;
  const docResult = await store.getDocumentByUri(predecessorUri.trim());
  if (!docResult.ok) {
    throw new MemoryError("MEMORY_QUERY_FAILED", docResult.error.message);
  }
  const doc = docResult.value;
  if (!doc || !doc.active || doc.collection !== collection) {
    throw new MemoryError(
      "MEMORY_PREDECESSOR_NOT_FOUND",
      `Predecessor ${predecessorUri} is not a current record in collection "${collection}".`
    );
  }
  const predecessor = await readFact(store, doc);
  if (!predecessor) {
    throw new MemoryError(
      "MEMORY_PREDECESSOR_NOT_FOUND",
      `Predecessor ${predecessorUri} is not a valid managed memory record.`
    );
  }
  if (predecessor.contentHash !== predecessorHash) {
    throw new MemoryError(
      "MEMORY_PREDECESSOR_HASH_MISMATCH",
      `Predecessor ${predecessorUri} has content hash ${predecessor.contentHash}, not ${predecessorHash}. Recall it again before superseding.`
    );
  }
  const successors = await store.getEdgeBacklinksForDoc(doc.id, {
    edgeType: MEMORY_SUPERSEDES_EDGE,
  });
  if (!successors.ok) {
    throw new MemoryError("MEMORY_QUERY_FAILED", successors.error.message);
  }
  if (successors.value.length > 0) {
    const successor = successors.value[0];
    throw new MemoryError(
      "MEMORY_SUPERSEDE_CONFLICT",
      `Predecessor ${predecessorUri} was already superseded by ${successor?.sourceUri ?? "another record"}. Recall the current fact and decide again.`
    );
  }
  return doc.uri;
}

/** Under the lease, after sync: every predecessor URI has a projected edge. */
async function supersedesEdgeProjected(
  deps: MemoryServiceDeps,
  successorDocId: number,
  predecessorUris: readonly string[]
): Promise<boolean> {
  const edges = await deps.store.getEdgesForDoc(successorDocId, {
    edgeType: MEMORY_SUPERSEDES_EDGE,
  });
  if (!edges.ok) return false;
  const targets = new Set(edges.value.map((edge) => edge.targetUri));
  return predecessorUris.every((uri) => targets.has(uri));
}

// ─────────────────────────────────────────────────────────────────────────────
// remember
// ─────────────────────────────────────────────────────────────────────────────

export async function rememberFact(
  deps: MemoryServiceDeps,
  rawInput: RememberInput
): Promise<RememberResult> {
  const { store, collections, config } = deps;
  const identity = requireIdentity(rawInput);
  const text = requireFactText(rawInput.text);
  const collection = requireManagedCollection(collections, rawInput.collection);
  const scopes = requireScopes(rawInput.scopes);
  const decision = requireDecision(rawInput.decision);
  const contentHash = hashMemoryText(text);
  applyFence(rawInput, contentHash);

  if (decision === "supersede") {
    if (!rawInput.predecessorUri?.trim() || !rawInput.predecessorHash) {
      throw new MemoryError(
        "MEMORY_PREDECESSOR_REQUIRED",
        "supersede requires predecessorUri and predecessorHash."
      );
    }
  }

  const { candidates, matching } = await findMemoryCandidates(deps, {
    text,
    collection: collection.name,
    scopes,
  });
  const exact = candidates.find((candidate) => candidate.match === "exact");
  if (exact && decision !== "supersede") {
    const { similarity: _similarity, match: _match, ...record } = exact;
    return { outcome: "existing", record, matching };
  }
  if (decision === undefined) {
    return { outcome: "candidates", candidates, matching };
  }

  const createdAt = memoryNow(deps).toISOString();
  const source = rawInput.source?.trim() || undefined;
  const frontmatter: MemoryRecordFrontmatter = {
    recordId: buildMemoryRecordId({
      contentHash,
      createdAt,
      caller: identity.caller,
      session: identity.session,
    }),
    scopes,
    caller: identity.caller,
    session: identity.session,
    createdAt,
    contentHash,
    ...(source ? { source } : {}),
  };
  const relPath = buildMemoryRecordRelPath(frontmatter);
  const absPath = join(collection.path, relPath);
  const lockWaitMs = memoryLockWaitMs(deps);

  let leased: RememberResult;
  try {
    leased = await withWriteLock(
      deps.lockPath,
      async () => {
        const supersedes: string[] = [];
        if (decision === "supersede") {
          supersedes.push(
            await verifyPredecessor(
              deps,
              collection.name,
              rawInput.predecessorUri as string,
              rawInput.predecessorHash as string
            )
          );
        } else {
          // The pre-lease check raced with any concurrent writer; decide
          // idempotency on the state visible under the lease.
          const existing = await findExactCurrent(deps, {
            text,
            collection: collection.name,
            scopes,
            contentHash,
          });
          if (existing) {
            return { outcome: "existing", record: existing, matching };
          }
        }
        await mkdir(dirname(absPath), { recursive: true });
        await atomicCreate(
          absPath,
          serializeMemoryRecord({ frontmatter, supersedes, text })
        );
        // syncPaths (not syncFiles) so typed-edge projection errors surface.
        const syncResult = await (
          deps.syncService ?? defaultSyncService
        ).syncPaths(
          collection,
          store,
          [relPath],
          withContentTypeRules({ runUpdateCmd: false, gitPull: false }, config)
        );
        const fileResult = syncResult.files?.[0];
        const doc = await store.getDocument(collection.name, relPath);
        const sync: MemorySyncState =
          fileResult?.status === "error" || !doc.ok || doc.value === null
            ? {
                status: "failed",
                error:
                  fileResult?.errorMessage ??
                  fileResult?.errorCode ??
                  "memory record was written but is not retrievable yet",
              }
            : { status: "completed" };
        if (sync.status === "failed") {
          throw new MemoryError(
            "MEMORY_SYNC_FAILED",
            `Memory record written to ${absPath} but lexical sync failed: ${sync.error}. Run gno update to retry indexing.`
          );
        }
        const written = (doc as { value: DocumentRow }).value;
        const projectionErrors = syncResult.errors
          .map((error) => `${error.relPath}: ${error.message}`)
          .join("; ");
        if (decision === "supersede") {
          // The write is only a supersession once the edge is projected;
          // until then the predecessor still reads as current.
          const projected =
            projectionErrors.length === 0 &&
            (await supersedesEdgeProjected(deps, written.id, supersedes));
          if (!projected) {
            throw new MemoryError(
              "MEMORY_SUPERSEDE_PROJECTION_FAILED",
              `Successor written to ${absPath} but its supersedes edge did not project${projectionErrors ? ` (${projectionErrors})` : ""}; the predecessor still reads as current. Run gno update to retry the projection.`
            );
          }
        } else if (projectionErrors.length > 0) {
          throw new MemoryError(
            "MEMORY_SYNC_FAILED",
            `Memory record written to ${absPath} but typed-edge projection failed: ${projectionErrors}. Run gno update to retry indexing.`
          );
        }
        const record: MemoryFact = {
          uri: written.uri,
          docid: written.docid,
          recordId: frontmatter.recordId,
          text,
          scopes,
          caller: identity.caller,
          session: identity.session,
          createdAt,
          contentHash,
          supersedes,
          ...(source ? { source } : {}),
        };
        return {
          outcome: decision === "supersede" ? "superseded" : "added",
          record,
          absPath,
          sync,
          matching,
        };
      },
      lockWaitMs
    );
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("LOCKED")) {
      throw new MemoryError(
        "MEMORY_WRITE_LEASE_BUSY",
        `Could not acquire the shared write lease at ${deps.lockPath} within ${lockWaitMs}ms: another write holds it. The memory service takes the lease itself; callers must not pre-hold it.`
      );
    }
    throw error;
  }
  return leased;
}
