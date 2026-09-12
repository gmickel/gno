import type { Database } from "bun:sqlite";

import type {
  ChunkingPolicyToken,
  ChunkingStatus,
  PendingChunkingMirror,
} from "../chunking";

import {
  ChunkingConfigSchema,
  chunkingPolicyKey,
  DEFAULT_CHUNKING_PARAMS,
  DEFAULT_CHUNKING_POLICY_KEY,
  resolveChunkingParams,
  type ChunkingParams,
} from "../../config/chunking";
import { ChunkingPolicyConflictError } from "../chunking";

const TARGET_KEY = "chunking_policy_v1";
const LAYOUT_PREFIX = "chunking_mirror_v1:";

export function readChunkingTarget(db: Database): ChunkingPolicyToken {
  const row = db
    .query<{ value: string }, [string]>(
      "SELECT value FROM schema_meta WHERE key = ?"
    )
    .get(TARGET_KEY);
  if (!row) return { params: { ...DEFAULT_CHUNKING_PARAMS }, generation: 0 };
  const parsed: unknown = JSON.parse(row.value);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("generation" in parsed) ||
    !Number.isSafeInteger(parsed.generation) ||
    typeof parsed.generation !== "number" ||
    parsed.generation < 1 ||
    !("params" in parsed)
  ) {
    throw new Error("Invalid stored chunking policy");
  }
  return {
    params: ChunkingConfigSchema.parse(parsed.params),
    generation: parsed.generation,
  };
}

export function assertChunkingTarget(
  db: Database,
  token: ChunkingPolicyToken
): void {
  const current = readChunkingTarget(db);
  if (
    current.generation !== token.generation ||
    chunkingPolicyKey(current.params) !== chunkingPolicyKey(token.params)
  ) {
    throw new ChunkingPolicyConflictError();
  }
}

/** Called while the adapter holds its transaction writer. */
export function claimChunkingTarget(
  db: Database,
  observedGeneration: number,
  params: ChunkingParams
): ChunkingPolicyToken {
  const current = readChunkingTarget(db);
  if (current.generation !== observedGeneration) {
    throw new ChunkingPolicyConflictError();
  }
  if (chunkingPolicyKey(current.params) === chunkingPolicyKey(params)) {
    return current;
  }
  const generation = current.generation + 1;
  if (!Number.isSafeInteger(generation)) {
    throw new Error("Chunking policy generation exhausted");
  }
  const target = { params, generation };
  db.run(
    "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [TARGET_KEY, JSON.stringify(target)]
  );
  return target;
}

/** Keyset paging bounds memory even for a large index. */
export function pendingChunkingMirrors(
  db: Database,
  token: ChunkingPolicyToken,
  afterHash: string
): PendingChunkingMirror[] {
  assertChunkingTarget(db, token);
  // No policy has ever changed, so every legacy/default layout is current.
  if (token.generation === 0) return [];
  return db
    .query<
      {
        mirror_hash: string;
        source_path: string;
        language_hint: string | null;
      },
      [string, string, string, string]
    >(
      `SELECT c.mirror_hash,
         COALESCE(json_extract(m.value, '$.sourcePath'), d.rel_path) AS source_path,
         CASE WHEN m.value IS NOT NULL
           THEN json_extract(m.value, '$.languageHint') ELSE d.language_hint END AS language_hint
       FROM content c JOIN documents d ON d.id = (
         SELECT id FROM documents
         WHERE mirror_hash = c.mirror_hash AND active = 1
         ORDER BY collection, rel_path, id LIMIT 1
       )
       LEFT JOIN schema_meta m ON m.key = ? || c.mirror_hash
       WHERE c.mirror_hash > ?
         AND COALESCE(json_extract(m.value, '$.params'), ?) <> ?
       ORDER BY c.mirror_hash LIMIT 64`
    )
    .all(
      LAYOUT_PREFIX,
      afterHash,
      DEFAULT_CHUNKING_POLICY_KEY,
      chunkingPolicyKey(token.params)
    )
    .map((row) => ({
      mirrorHash: row.mirror_hash,
      sourcePath: row.source_path,
      languageHint: row.language_hint ?? undefined,
    }));
}

export function markChunkingApplied(
  db: Database,
  mirrorHash: string,
  token: ChunkingPolicyToken,
  sourcePath: string,
  languageHint?: string
): void {
  const updated = db.run(
    `INSERT INTO schema_meta (key, value)
     SELECT ?, ? WHERE EXISTS (SELECT 1 FROM content WHERE mirror_hash = ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [
      `${LAYOUT_PREFIX}${mirrorHash}`,
      JSON.stringify({ params: token.params, sourcePath, languageHint }),
      mirrorHash,
    ]
  );
  if (updated.changes !== 1)
    throw new Error("Cannot mark a missing cached mirror applied");
}

export function getChunkingStatus(
  db: Database,
  configured?: Partial<ChunkingParams>
): ChunkingStatus {
  const params = resolveChunkingParams(
    configured ?? readChunkingTarget(db).params
  );
  const key = chunkingPolicyKey(params);
  const groups = db
    .query<
      { policy: string | null; documents: number; mirrors: number },
      [string]
    >(
      `SELECT json_extract(m.value, '$.params') AS policy, COUNT(*) AS documents,
         COUNT(DISTINCT c.mirror_hash) AS mirrors
       FROM content c JOIN documents d ON d.mirror_hash = c.mirror_hash
       LEFT JOIN schema_meta m ON m.key = ? || c.mirror_hash
       WHERE d.active = 1 GROUP BY policy`
    )
    .all(LAYOUT_PREFIX);
  const appliedPolicies = new Map<string, ChunkingParams>();
  let pendingDocuments = 0;
  let pendingMirrors = 0;
  for (const group of groups) {
    const applied = group.policy
      ? ChunkingConfigSchema.parse(JSON.parse(group.policy))
      : { ...DEFAULT_CHUNKING_PARAMS };
    const appliedKey = chunkingPolicyKey(applied);
    appliedPolicies.set(appliedKey, applied);
    if (appliedKey !== key) {
      pendingDocuments += group.documents;
      pendingMirrors += group.mirrors;
    }
  }
  let state: ChunkingStatus["state"] = "current";
  if (groups.length === 0) state = "empty";
  else if (appliedPolicies.size > 1) state = "mixed";
  else if (pendingMirrors > 0) state = "pending";
  else if (groups.every((group) => group.policy === null))
    state = "legacy-default";

  return {
    configured: params,
    applied:
      appliedPolicies.size === 1
        ? (appliedPolicies.values().next().value ?? null)
        : null,
    state,
    pendingDocuments,
    pendingMirrors,
  };
}

export function pruneChunkingMetadata(db: Database): void {
  db.run(
    `DELETE FROM schema_meta WHERE key GLOB ?
       AND NOT EXISTS (
         SELECT 1 FROM content WHERE mirror_hash = substr(schema_meta.key, ?)
       )`,
    [`${LAYOUT_PREFIX}*`, LAYOUT_PREFIX.length + 1]
  );
}
