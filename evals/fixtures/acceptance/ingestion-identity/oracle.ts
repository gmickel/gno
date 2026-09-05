/** Independent, synthetic fn-147 oracle. Never derive expected input from a mirror. */
// Bun has no filesystem structure or path/temp-directory APIs.
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../../../src/config/types";
import type { AcceptanceRecord } from "../../../acceptance/records";

import { getEmbeddingFingerprint } from "../../../../src/embed/fingerprint";
import { SyncService } from "../../../../src/ingestion";
import { formatDocForEmbedding } from "../../../../src/pipeline/contextual";
import { SqliteAdapter } from "../../../../src/store/sqlite/adapter";
import { createVectorStatsPort } from "../../../../src/store/vector/stats";
import { safeRm } from "../../../../test/helpers/cleanup";
import { compareAcceptance } from "../../../acceptance/compare";
import {
  ACCEPTANCE_SCHEMA_VERSION,
  acceptanceManifestFingerprint,
  type AcceptanceManifest,
} from "../../../acceptance/manifest";

export const body = "The cobalt observatory opens at dawn.\n";
export const changedBody = "The cobalt observatory opens at dusk.\n";
export const whitespaceBody = "The cobalt observatory opens at dawn.  \r\n\r\n";
export const model = "test-embedding-v1";
export const nextModel = "test-embedding-v2";
export const fixture = {
  version: "ingestion-identity-v1",
  body,
  changedBody,
  whitespaceBody,
  chunk: "The cobalt observatory opens at dawn.\n",
  changedChunk: "The cobalt observatory opens at dusk.\n",
  inputs: {
    Alpha: "title: Alpha | text: The cobalt observatory opens at dawn.\n",
    Beta: "title: Beta | text: The cobalt observatory opens at dawn.\n",
    changed: "title: Alpha | text: The cobalt observatory opens at dusk.\n",
  },
  policy: {
    dimensions: 8,
    context: "complete-fixture-no-truncation",
    model,
    nextModel,
  },
  // Counts are required behavior, independently frozen before production fixes.
  expectations: {
    sameTitle: { calls: [1, 0], events: ["create", "create"] },
    whitespace: { calls: [1, 0], events: ["create", "update"] },
    titleOrders: { calls: [1, 1], cleanCalls: 2 },
    content: { calls: [1, 1], events: ["create", "update"] },
    model: { calls: [1, 1, 0] },
    restoration: {
      calls: [1, 0, 0, 0, 0, 0, 0],
      events: [
        "create",
        "inactivate",
        "reactivate",
        "inactivate",
        "reactivate",
      ],
    },
    rename: { calls: [1, 1], events: ["create", "create", "inactivate"] },
  },
};
export function hash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}
export const fixtureHash = hash(JSON.stringify(fixture));

/** Exactly representable fake vectors encode the entire input AND model identity.
 * No native model, similarity claim, production fingerprint or title helper here. */
export function vector(input: string, modelId = model): number[] {
  const digest = hash(JSON.stringify([modelId, fixture.policy, input]));
  return Array.from({ length: 8 }, (_, i) =>
    Number.parseInt(digest.slice(i * 4, i * 4 + 4), 16)
  );
}
export interface Owner {
  path: string;
  title: string;
  mirror: string;
  chunk: string;
  seq: number;
  model: string;
  embedding: number[] | null;
  inputHash: string | null;
}
export function expectedOwner(
  path: string,
  title: "Alpha" | "Beta",
  modelId = model,
  changed = false
): Owner {
  return {
    path,
    title,
    mirror: hash(changed ? changedBody : body),
    chunk: changed ? fixture.changedChunk : fixture.chunk,
    seq: 0,
    model: modelId,
    inputHash: hash(changed ? fixture.inputs.changed : fixture.inputs[title]),
    embedding: vector(
      changed ? fixture.inputs.changed : fixture.inputs[title],
      modelId
    ),
  };
}

/** fn-143 comparator, separate new scenario identity; no frozen baseline edits. */
export function equivalent(expected: Owner[], observed: Owner[]): boolean {
  const baseline: AcceptanceManifest = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    role: "baseline",
    identity: {
      commit: "0".repeat(40),
      indexId: "independent-oracle",
      indexSha256: fixtureHash,
      bunVersion: Bun.version,
      nativeDependencies: {},
      platform: process.platform,
      architecture: process.arch,
    },
    fixtureVersion: fixture.version,
    fixtures: [{ path: "ingestion-identity/oracle.ts", sha256: fixtureHash }],
    models: [
      {
        role: "embedding",
        id: model,
        sha256: fixtureHash,
        tokenizerSha256: fixtureHash,
      },
    ],
    cases: [
      {
        caseId: "ownership",
        fixtureSha256: fixtureHash,
        surface: "sdk",
        preset: "balanced",
        configuration: {},
      },
    ],
    intendedDeltas: [],
  };
  const candidate = structuredClone(baseline);
  candidate.role = "candidate";
  candidate.identity.indexId = "actual-store";
  const record = (
    owners: Owner[],
    manifest: AcceptanceManifest
  ): AcceptanceRecord => ({
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    manifestSha256: acceptanceManifestFingerprint(manifest),
    caseId: "ownership",
    deterministic: {
      scope: { owners: owners.map((owner) => ({ ...owner })) },
      results: [],
      citations: [],
      modelInputs: [],
      semanticState: {
        status: "incomplete",
        vectorsUsed: false,
        vectorStatus: "not-requested",
        error: null,
        fallbacks: [],
        verification: { native: "not-run" },
      },
    },
    generatedAnswer: null,
    transport: {},
  });
  return compareAcceptance(
    baseline,
    candidate,
    [record(expected, baseline)],
    [record(observed, candidate)]
  ).passed;
}

export async function openHarness() {
  const root = await mkdtemp(join(tmpdir(), "gno-identity-"));
  const path = join(root, "sources");
  await mkdir(path);
  const store = new SqliteAdapter();
  const opened = await store.open(join(root, "index.sqlite"), "unicode61");
  if (!opened.ok) throw new Error(opened.error.message);
  const collection: Collection = {
    name: "identity",
    path,
    pattern: "**/*.md",
    include: [],
    exclude: [],
  };
  const synced = await store.syncCollections([collection]);
  if (!synced.ok) throw new Error(synced.error.message);
  const service = new SyncService();
  const calls: { input: string; model: string }[] = [];
  const provenance = new Map<string, string>();
  return {
    root,
    path,
    store,
    calls,
    async write(name: string, text = body) {
      await mkdir(join(path, name, ".."), { recursive: true });
      await Bun.write(join(path, name), text);
    },
    sync: () => service.syncCollection(collection, store),
    async embed(modelId = model) {
      const fingerprint = getEmbeddingFingerprint({
        modelUri: modelId,
        dimensions: 8,
      });
      const backlog = await createVectorStatsPort(store.getRawDb()).getBacklog(
        modelId,
        fingerprint
      );
      if (!backlog.ok) throw new Error(backlog.error.message);
      for (const item of backlog.value) {
        const input = formatDocForEmbedding(
          item.text,
          item.title ?? undefined,
          modelId
        );
        calls.push({ input, model: modelId });
        provenance.set(
          JSON.stringify([modelId, vector(input, modelId)]),
          hash(input)
        );
        store
          .getRawDb()
          .run(
            "INSERT OR REPLACE INTO content_vectors (mirror_hash,seq,model,embed_fingerprint,embedding) VALUES (?,?,?,?,?)",
            [
              item.mirrorHash,
              item.seq,
              modelId,
              fingerprint,
              new Float32Array(vector(input, modelId)),
            ]
          );
      }
      return backlog.value.length;
    },
    snapshot(modelId = model): Owner[] {
      const rows = store
        .getRawDb()
        .query(
          `SELECT d.rel_path AS path, d.title, d.mirror_hash AS mirror, c.text AS chunk, c.seq, v.embedding FROM documents d JOIN content_chunks c ON c.mirror_hash=d.mirror_hash LEFT JOIN content_vectors v ON v.mirror_hash=c.mirror_hash AND v.seq=c.seq AND v.model=? WHERE d.active=1 ORDER BY d.rel_path,c.seq`
        )
        .all(modelId) as (Omit<Owner, "model" | "embedding"> & {
        embedding: Uint8Array | null;
      })[];
      return rows.map((row) => {
        const embedding = row.embedding
          ? Array.from(new Float32Array(row.embedding.slice().buffer))
          : null;
        return {
          ...row,
          model: modelId,
          embedding,
          inputHash:
            provenance.get(JSON.stringify([modelId, embedding])) ?? null,
        };
      });
    },
    async events(): Promise<string[]> {
      const result = await store.listDocumentChanges();
      if (!result.ok) throw new Error(result.error.message);
      return result.value.changes.map((change) => change.kind);
    },
    async close() {
      await store.close();
      await safeRm(root);
    },
  };
}
