import { describe, expect, test } from "bun:test";

import type { EphemeralActivationProbePlan } from "../../src/core/activation-probe-plan";
import type {
  ActivationVerificationReceipt,
  StorePort,
} from "../../src/store/types";

import { buildActivationStatus } from "../../src/core/activation-status";
import { getConnectorActivationReceiptLookup } from "../../src/core/connector-verifier";

const HASH = "a".repeat(64);

function probePlan(
  collection: string,
  fingerprint: string
): EphemeralActivationProbePlan {
  return {
    collection,
    fingerprint,
    identity: {
      indexName: "default",
      schemaVersion: 12,
      ftsTokenizer: "unicode61",
      ftsStateHash: fingerprint,
    },
    activeDocuments: [],
    candidates: [],
  };
}

function receipt(
  collection: string,
  ready: boolean,
  code: "no_documents" | "retrieval_mismatch" = "no_documents"
): ActivationVerificationReceipt {
  return {
    schemaVersion: "1.0",
    collection,
    fingerprint: HASH,
    ready,
    generatedAt: "2026-07-22T10:00:00.000Z",
    stages: {
      index: {
        status: ready || code === "retrieval_mismatch" ? "passed" : "failed",
        startedAt: null,
        completedAt: null,
        latencyMs: 0,
        ...(!ready && code === "no_documents" ? { code } : {}),
      },
      lexical: {
        status: ready
          ? "passed"
          : code === "no_documents"
            ? "skipped"
            : "failed",
        startedAt: null,
        completedAt: null,
        latencyMs: 0,
        ...(!ready ? { code } : {}),
      },
      semantic: {
        status: "pending",
        startedAt: null,
        completedAt: null,
        latencyMs: null,
        code: "semantic_not_checked",
      },
      connector: {
        status: "skipped",
        startedAt: null,
        completedAt: null,
        latencyMs: null,
        code: "connector_not_requested",
      },
    },
    evidence: ready
      ? {
          probeHash: HASH,
          resultUri: `gno://${collection}/proof.md`,
          resultSourceHash: HASH,
        }
      : {},
  };
}

describe("activation status", () => {
  const store = {} as StorePort;

  test("distinguishes usable mixed state from fully healthy state", async () => {
    const status = await buildActivationStatus(store, ["zeta", "alpha"], {
      semantic: {
        modelsCached: false,
        embeddingBacklog: 9,
        vectorAvailable: false,
      },
      verifyCollection: async (_store, collection) => ({
        ok: true,
        value: receipt(collection, collection === "zeta"),
      }),
    });

    expect(status.collections.map(({ collection }) => collection)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(status.usable).toBe(true);
    expect(status.healthy).toBe(false);
    expect(status.collections[0]?.remediation).toMatchObject({
      stage: "index",
      code: "no_documents",
      command: "gno index alpha --no-embed",
    });
    expect(status.collections[1]?.semanticAvailability).toEqual({
      status: "pending",
      code: "models_missing",
      command: "gno models pull --embed",
    });
  });

  test("treats semantic pending as independent from lexical health", async () => {
    const status = await buildActivationStatus(store, ["notes"], {
      semantic: {
        modelsCached: true,
        embeddingBacklog: 4,
        vectorAvailable: true,
      },
      verifyCollection: async () => ({
        ok: true,
        value: receipt("notes", true),
      }),
    });

    expect(status).toMatchObject({ usable: true, healthy: true });
    expect(status.collections[0]?.semanticAvailability).toMatchObject({
      status: "pending",
      code: "embeddings_pending",
    });
    expect(status.collections[0]?.stages.semantic.status).not.toBe("passed");
  });

  test("fails closed for no configured collections and verifier errors", async () => {
    const empty = await buildActivationStatus(store, [], {
      verifyCollection: async () => ({
        ok: true,
        value: receipt("unused", true),
      }),
    });
    expect(empty).toMatchObject({
      usable: false,
      healthy: false,
      collections: [],
    });

    const failed = await buildActivationStatus(store, ["notes"], {
      verifyCollection: async () => ({
        ok: false,
        error: { code: "QUERY_FAILED", message: "private backend detail" },
      }),
    });
    expect(failed.collections[0]).toMatchObject({
      ready: false,
      stages: { index: { status: "failed", code: "index_query_failed" } },
    });
    expect(JSON.stringify(failed)).not.toContain("private backend detail");
  });

  test("coalesces only concurrent checks and never keeps a settled TTL cache", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verifyCollection = async () => {
      calls += 1;
      await gate;
      return { ok: true as const, value: receipt("notes", true) };
    };

    const first = buildActivationStatus(store, ["notes"], { verifyCollection });
    const second = buildActivationStatus(store, ["notes"], {
      verifyCollection,
    });
    await Bun.sleep(0);
    expect(calls).toBe(1);
    release?.();
    await Promise.all([first, second]);

    await buildActivationStatus(store, ["notes"], { verifyCollection });
    expect(calls).toBe(2);
  });

  test("does not coalesce concurrent checks across different fingerprints", async () => {
    let prepared = 0;
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const options = {
      prepareCollection: async (_store: StorePort, collection: string) => {
        prepared += 1;
        return {
          ok: true as const,
          value: probePlan(collection, prepared === 1 ? HASH : "b".repeat(64)),
        };
      },
      verifyCollection: async (
        _store: StorePort,
        collection: string,
        plan?: EphemeralActivationProbePlan
      ) => {
        calls += 1;
        await gate;
        return {
          ok: true as const,
          value: {
            ...receipt(collection, true),
            fingerprint: plan!.fingerprint,
          },
        };
      },
    };

    const first = buildActivationStatus(store, ["notes"], options);
    await Bun.sleep(0);
    const second = buildActivationStatus(store, ["notes"], options);
    await Bun.sleep(0);
    expect(calls).toBe(2);
    release?.();
    const [oldStatus, newStatus] = await Promise.all([first, second]);
    expect(oldStatus.collections[0]?.generatedAt).not.toBeNull();
    expect(newStatus.collections[0]?.generatedAt).not.toBeNull();
  });

  test("bounds collection verification concurrency", async () => {
    let active = 0;
    let peak = 0;
    const status = await buildActivationStatus(
      {} as StorePort,
      ["a", "b", "c", "d", "e"],
      {
        concurrency: 2,
        verifyCollection: async (_store, collection) => {
          active += 1;
          peak = Math.max(peak, active);
          await Bun.sleep(2);
          active -= 1;
          return { ok: true, value: receipt(collection, true) };
        },
      }
    );
    expect(status.healthy).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("projects only fingerprint-current connector receipts passively", async () => {
    const lexical = receipt("notes", true);
    const target = {
      kind: "mcp" as const,
      id: "cursor-mcp",
      target: "cursor",
      scope: "user" as const,
      configPath: "/tmp/cursor.json",
      configured: true,
      serverEntry: { command: "/usr/local/bin/gno", args: ["mcp"] },
    };
    const lookup = getConnectorActivationReceiptLookup(
      lexical.fingerprint,
      target
    );
    const cached: ActivationVerificationReceipt = {
      ...lexical,
      fingerprint: lookup.fingerprint,
      stages: {
        ...lexical.stages,
        connector: {
          status: "passed",
          startedAt: null,
          completedAt: null,
          latencyMs: 4,
        },
      },
      evidence: {
        ...lexical.evidence,
        connectorTarget: lookup.connectorTarget,
      },
    };
    const receiptReads: string[] = [];
    const connectorStore = {
      getActivationReceipt: async (
        _collection: string,
        fingerprint: string
      ) => {
        receiptReads.push(fingerprint);
        return {
          ok: true as const,
          value: fingerprint === lookup.fingerprint ? cached : null,
        };
      },
    } as StorePort;
    const options = {
      connectorTargets: [target],
      verifyCollection: async () => ({ ok: true as const, value: lexical }),
    };

    const current = await buildActivationStatus(
      connectorStore,
      ["notes"],
      options
    );
    expect(current.connectors[0]).toMatchObject({
      collection: "notes",
      target: "cursor-mcp",
      status: "passed",
      remediation: null,
    });

    const changed = await buildActivationStatus(connectorStore, ["notes"], {
      ...options,
      connectorTargets: [
        {
          ...target,
          serverEntry: { ...target.serverEntry, args: ["mcp", "serve"] },
        },
      ],
    });
    expect(changed.connectors[0]).toMatchObject({
      status: "pending",
      code: "connector_not_requested",
    });
    expect(receiptReads[0]).toBe(lookup.fingerprint);
    expect(receiptReads[1]).not.toBe(lookup.fingerprint);
  });

  test("bounds connector projections and reports truncation", async () => {
    const collections = ["a", "b", "c", "d", "e"];
    const connectorTargets = Array.from({ length: 17 }, (_, index) => ({
      kind: "skill" as const,
      id: `skill-${index.toString().padStart(2, "0")}`,
      target: `skill-${index}`,
      scope: "user" as const,
      configPath: `/tmp/skill-${index}`,
      installed: false,
    }));
    const status = await buildActivationStatus({} as StorePort, collections, {
      connectorTargets,
      verifyCollection: async (_store, collection) => ({
        ok: true,
        value: receipt(collection, true),
      }),
    });

    expect(status.connectors).toHaveLength(64);
    expect(status.connectorProjection).toEqual({
      total: 85,
      projected: 64,
      truncated: true,
    });
  });
});
