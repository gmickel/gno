// Bun has no directory creation/removal API.
import { mkdir, mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { AcceptanceRecord } from "../../../acceptance/records";

import { SyncService } from "../../../../src/ingestion";
import { SqliteAdapter } from "../../../../src/store/sqlite/adapter";
import { safeRm } from "../../../../test/helpers/cleanup";
import { compareAcceptance } from "../../../acceptance/compare";
import {
  ACCEPTANCE_SCHEMA_VERSION,
  acceptanceManifestFingerprint,
  type AcceptanceManifest,
} from "../../../acceptance/manifest";
import { canonicalFingerprint } from "../../../agentic/canonical";
import { initialSources, mutate, mutations, rules, sizes } from "./fixture";

export const fixtureHash = canonicalFingerprint({
  states: (() => {
    const sources = initialSources();
    return mutations.map((step) => {
      mutate(sources, step);
      return { step, sources: { ...sources } };
    });
  })(),
  sizes,
  rules: [rules(), rules("attended")],
});
const snapshotSchema = z.record(z.string(), z.json());
type GraphSnapshot = z.infer<typeof snapshotSchema>;

export async function openFixture() {
  const root = await mkdtemp(join(tmpdir(), "graph-oracle-"));
  const store = new SqliteAdapter();
  const opened = await store.open(":memory:", "porter");
  if (!opened.ok) throw new Error(opened.error.message);
  const collections = ["targets", "outside"].map((name) => ({
    name,
    path: join(root, name),
    pattern: "**/*.md",
    include: [],
    exclude: [],
  }));
  for (const collection of collections) await mkdir(collection.path);
  const synced = await store.syncCollections(collections);
  if (!synced.ok) throw new Error(synced.error.message);
  let previous: Record<string, string> = {};
  return {
    store,
    collections,
    async write(sources: Record<string, string>) {
      for (const path of Object.keys(previous))
        if (!(path in sources)) await unlink(join(root, path));
      for (const [path, body] of Object.entries(sources)) {
        if (previous[path] !== body) await Bun.write(join(root, path), body);
      }
      previous = { ...sources };
    },
    async close() {
      await store.close();
      await safeRm(root);
    },
  };
}

export async function snapshot(store: SqliteAdapter) {
  const edges = store
    .getRawDb()
    .query(`SELECT s.uri AS src, d.uri AS dst, e.edge_type, e.confidence, e.source
    FROM doc_edges e JOIN documents s ON s.id=e.src_doc_id JOIN documents d ON d.id=e.dst_doc_id
    WHERE s.active=1 AND d.active=1 ORDER BY s.uri,d.uri,e.edge_type,e.confidence,e.source`)
    .all();
  const diagnostics = [];
  for (const collection of [undefined, "targets", "outside"]) {
    const graph = await store.getGraph({
      collection,
      limitNodes: 100,
      limitEdges: 100,
    });
    if (!graph.ok) throw new Error(graph.error.message);
    diagnostics.push({
      collection: collection ?? "all",
      unresolved: graph.value.report.unresolvedLinks,
      audit: graph.value.report.audit,
    });
    // Guaranteed ordering is checked against a second call on the same inventory;
    // fresh databases need not share insertion IDs after delete/restore.
    const repeated = await store.getGraph({
      collection,
      limitNodes: 100,
      limitEdges: 100,
    });
    if (
      !repeated.ok ||
      JSON.stringify(repeated.value) !== JSON.stringify(graph.value)
    )
      throw new Error("unstable graph ordering");
    if (
      graph.value.nodes.some(
        (node) => collection && node.collection !== collection
      )
    )
      throw new Error("scope leakage");
  }
  return snapshotSchema.parse({ edges, diagnostics });
}

export async function fullRebuild(
  sources: Record<string, string>,
  hint: string,
  sourceOrder?: string[]
) {
  const fixture = await openFixture();
  try {
    await fixture.write(sources);
    const service = new SyncService();
    if (sourceOrder) {
      // Keep relative insertion precedence: ambiguity resolution currently uses
      // document IDs. Never reuse edge state or numeric IDs from the candidate.
      for (const path of sourceOrder) {
        if (!(path in sources)) continue;
        const collection = fixture.collections.find((item) =>
          path.startsWith(`${item.name}/`)
        )!;
        await service.syncPaths(
          collection,
          fixture.store,
          [path.slice(collection.name.length + 1)],
          { contentTypeRules: rules(hint) }
        );
      }
    } else {
      await service.syncAll(fixture.collections, fixture.store, {
        contentTypeRules: rules(hint),
      });
    }
    const errors = await service.reconcileTypedEdges(fixture.store, {
      contentTypeRules: rules(hint),
    });
    if (errors.length) throw new Error(JSON.stringify(errors));
    return await snapshot(fixture.store);
  } finally {
    await fixture.close();
  }
}

export function compareGraph(
  caseId: string,
  expected: GraphSnapshot,
  actual: GraphSnapshot
) {
  const manifest: AcceptanceManifest = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    role: "baseline",
    identity: {
      commit: "0".repeat(40),
      indexId: "fresh-global-oracle",
      indexSha256: canonicalFingerprint(expected),
      bunVersion: Bun.version,
      nativeDependencies: {},
      platform: process.platform,
      architecture: process.arch,
    },
    fixtureVersion: "graph-reconciliation-v1",
    fixtures: [{ path: "graph-reconciliation", sha256: fixtureHash }],
    models: [],
    cases: [
      {
        caseId,
        fixtureSha256: fixtureHash,
        surface: "sdk",
        preset: "graph",
        configuration: {},
      },
    ],
    intendedDeltas: [],
  };
  const candidate: AcceptanceManifest = {
    ...manifest,
    role: "candidate",
    identity: {
      ...manifest.identity,
      indexId: "incremental",
      indexSha256: canonicalFingerprint(actual),
    },
  };
  const record = (
    side: AcceptanceManifest,
    value: GraphSnapshot
  ): AcceptanceRecord => ({
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    manifestSha256: acceptanceManifestFingerprint(side),
    caseId,
    deterministic: {
      scope: value,
      results: [],
      citations: [],
      modelInputs: [],
      semanticState: {
        status: "ok",
        vectorsUsed: false,
        vectorStatus: "not-requested",
        error: null,
        fallbacks: [],
        verification: null,
      },
    },
    generatedAnswer: null,
    transport: {},
  });
  return compareAcceptance(
    manifest,
    candidate,
    [record(manifest, expected)],
    [record(candidate, actual)]
  );
}
