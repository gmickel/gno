import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for mkdtemp/mkdir)
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Collection, Config } from "../../src/config/types";
import type { EmbeddingPort, LlmResult } from "../../src/llm/types";

import { audit } from "../../src/cli/commands/audit";
import { formatStatus, status } from "../../src/cli/commands/status";
import { createDefaultConfig } from "../../src/config/defaults";
import { evaluateMemoryRecordAudit } from "../../src/core/audit-provenance";
import { acquireWriteLock } from "../../src/core/file-lock";
import {
  MEMORY_EMPTY_RECALL_HINT,
  MemoryError,
  MemoryService,
  type RememberInput,
} from "../../src/core/memory";
import { buildMemoryStatus } from "../../src/core/memory-diagnostics";
import { hashMemoryText } from "../../src/core/memory-record";
import { SyncService } from "../../src/ingestion";
import { searchBm25 } from "../../src/pipeline/search";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const IDENTITY = { caller: "codex", session: "session-1" };
const SCOPE = ["project:gno"];

interface Harness {
  root: string;
  store: SqliteAdapter;
  config: Config;
  collections: Collection[];
  lockPath: string;
  service: MemoryService;
}

function fakeEmbedPort(): EmbeddingPort {
  const dimensions = 64;
  const embed = (text: string): number[] => {
    const vector = Array.from({ length: dimensions }, () => 0);
    for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (!token) continue;
      let hash = 7;
      for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      const slot = hash % dimensions;
      vector[slot] = (vector[slot] ?? 0) + 1;
    }
    return vector;
  };
  return {
    modelUri: "fake://embed",
    init: async (): Promise<LlmResult<void>> => ({
      ok: true,
      value: undefined,
    }),
    embed: async (text: string): Promise<LlmResult<number[]>> => ({
      ok: true,
      value: embed(text),
    }),
    embedBatch: async (texts: string[]): Promise<LlmResult<number[][]>> => ({
      ok: true,
      value: texts.map(embed),
    }),
    dimensions: () => dimensions,
    dispose: async () => undefined,
  };
}

async function createHarness(
  prefix: string,
  options: { embedPort?: EmbeddingPort | null; dbPath?: string } = {}
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `gno-${prefix}-`));
  await mkdir(join(root, "memory"), { recursive: true });
  await mkdir(join(root, "notes"), { recursive: true });
  const collections: Collection[] = [
    {
      name: "memory",
      path: join(root, "memory"),
      pattern: "**/*.md",
      include: [],
      exclude: [],
      memoryManaged: true,
    },
    {
      name: "notes",
      path: join(root, "notes"),
      pattern: "**/*.md",
      include: [],
      exclude: [],
    },
  ];
  const config = { ...createDefaultConfig(), collections };
  const store = new SqliteAdapter();
  const dbPath = options.dbPath ?? join(root, "index.sqlite");
  await mkdir(join(dbPath, ".."), { recursive: true });
  const opened = await store.open(dbPath, config.ftsTokenizer);
  expect(opened.ok).toBe(true);
  expect((await store.syncCollections(collections)).ok).toBe(true);
  const lockPath = join(root, ".mcp-write.lock");
  const service = new MemoryService({
    store,
    config,
    collections,
    lockPath,
    lockWaitMs: 5_000,
    embedPort: options.embedPort ?? null,
  });
  return { root, store, config, collections, lockPath, service };
}

function remember(
  harness: Harness,
  input: Partial<RememberInput> & { text: string }
) {
  return harness.service.remember({
    ...IDENTITY,
    collection: "memory",
    scopes: SCOPE,
    ...input,
  });
}

async function expectMemoryError(
  promise: Promise<unknown>,
  code: string
): Promise<MemoryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryError);
    expect(String((error as MemoryError).code)).toBe(code);
    return error as MemoryError;
  }
  throw new Error(`expected ${code}`);
}

describe("MemoryService remember/recall contracts", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness("memory-service");
  });

  afterAll(async () => {
    await harness.store.close();
    await safeRm(harness.root);
  });

  test.each([
    [
      "unmanaged collection",
      { collection: "notes" },
      "MEMORY_COLLECTION_UNMANAGED",
    ],
    [
      "unknown collection",
      { collection: "nope" },
      "MEMORY_COLLECTION_NOT_FOUND",
    ],
    ["no scopes", { scopes: [] }, "MEMORY_SCOPES_REQUIRED"],
    [
      "too many scopes",
      { scopes: "abcdefghi".split("") },
      "MEMORY_SCOPES_INVALID",
    ],
    ["missing session", { session: "" }, "MEMORY_IDENTITY_REQUIRED"],
    ["bad decision", { decision: "merge" as never }, "MEMORY_DECISION_INVALID"],
    [
      "supersede without predecessor",
      { decision: "supersede" as const },
      "MEMORY_PREDECESSOR_REQUIRED",
    ],
  ])("remember rejects %s", async (_label, overrides, code) => {
    const error = await expectMemoryError(
      remember(harness, { text: "Finn likes trains.", ...overrides }),
      code
    );
    expect(error.message.length).toBeGreaterThan(10);
  });

  test.each([
    ["maxFacts", { maxFacts: 0 }],
    ["maxTokens", { maxTokens: 0 }],
  ])(
    "recall rejects a non-positive %s with MEMORY_BUDGET_INVALID",
    async (_label, budget) => {
      await expectMemoryError(
        harness.service.recall({
          ...IDENTITY,
          query: "trains",
          collection: "memory",
          scopes: SCOPE,
          ...budget,
        }),
        "MEMORY_BUDGET_INVALID"
      );
    }
  );

  test("recall rejects unmanaged collections, missing scopes, missing identity", async () => {
    await expectMemoryError(
      harness.service.recall({
        ...IDENTITY,
        query: "trains",
        collection: "notes",
        scopes: SCOPE,
      }),
      "MEMORY_COLLECTION_UNMANAGED"
    );
    await expectMemoryError(
      harness.service.recall({
        ...IDENTITY,
        query: "trains",
        collection: "memory",
        scopes: [],
      }),
      "MEMORY_SCOPES_REQUIRED"
    );
    await expectMemoryError(
      harness.service.recall({
        caller: "",
        session: "",
        query: "trains",
        collection: "memory",
        scopes: SCOPE,
      }),
      "MEMORY_IDENTITY_REQUIRED"
    );
  });

  test("absent decision proposes candidates and writes nothing", async () => {
    const result = await remember(harness, { text: "Finn likes trains." });
    expect(result.outcome).toBe("candidates");
    if (result.outcome !== "candidates") return;
    expect(result.candidates).toEqual([]);
    expect(result.matching.mode).toBe("lexical");
    const docs = await harness.store.listDocuments("memory");
    expect(docs.ok && docs.value).toEqual([]);
  });

  test("add writes the frontmatter contract and is retrievable before returning", async () => {
    const result = await remember(harness, {
      text: "Finn likes trains.",
      decision: "add",
    });
    expect(result.outcome).toBe("added");
    if (result.outcome !== "added") return;
    expect(result.sync.status).toBe("completed");
    const content = await Bun.file(result.absPath).text();
    expect(content).toContain("memory:");
    expect(content).toContain(`recordId: "${result.record.recordId}"`);
    expect(content).toContain('scopes: ["project:gno"]');
    expect(content).toContain('caller: "codex"');
    expect(content).toContain(
      `contentHash: "${hashMemoryText("Finn likes trains.")}"`
    );
    const doc = await harness.store.getDocumentByUri(result.record.uri);
    expect(doc.ok && doc.value?.active).toBe(true);
    const scopes = await harness.store.getDocMemoryScopes(
      (doc as { value: { id: number } }).value.id
    );
    expect(scopes.ok && scopes.value).toEqual(["project:gno"]);

    const recall = await harness.service.recall({
      ...IDENTITY,
      query: "trains",
      collection: "memory",
      scopes: ["PROJECT:GNO"],
    });
    expect(recall.facts.map((fact) => fact.text)).toEqual([
      "Finn likes trains.",
    ]);
    expect(recall.receipt.spanHashes).toEqual([result.record.contentHash]);
    expect(recall.receipt.memoryIds).toEqual([result.record.docid]);
    expect(recall.facts[0]?.egressLineage.effectivePolicy).toBe("local_only");
    expect(recall.egressLineage?.sources).toEqual([
      { collection: "memory", policy: "local_only", source: "config_default" },
    ]);
    expect(recall.hint).toBeUndefined();
  });

  test("exact duplicate is idempotent", async () => {
    const result = await remember(harness, {
      text: "  Finn   likes trains. ",
      decision: "add",
    });
    expect(result.outcome).toBe("existing");
    const docs = await harness.store.listDocuments("memory");
    expect(docs.ok && docs.value.length).toBe(1);
  });

  test("likely match without a decision returns the candidate, no write", async () => {
    const result = await remember(harness, {
      text: "Finn likes trains a lot.",
    });
    expect(result.outcome).toBe("candidates");
    if (result.outcome !== "candidates") return;
    expect(result.candidates.map((c) => [c.match, c.text])).toEqual([
      ["likely", "Finn likes trains."],
    ]);
    const docs = await harness.store.listDocuments("memory");
    expect(docs.ok && docs.value.length).toBe(1);
  });

  test("empty recall returns the self-teaching hint", async () => {
    const recall = await harness.service.recall({
      ...IDENTITY,
      query: "trains",
      collection: "memory",
      scopes: ["other-scope"],
    });
    expect(recall.facts).toEqual([]);
    expect(recall.hint).toBe(MEMORY_EMPTY_RECALL_HINT);
    expect(recall.egressLineage).toBeUndefined();
  });

  test("fence rejects receipted replay and derivedFrom gno:// input", async () => {
    const recall = await harness.service.recall({
      ...IDENTITY,
      query: "trains",
      collection: "memory",
      scopes: SCOPE,
    });
    await expectMemoryError(
      remember(harness, {
        text: "Finn likes trains.",
        decision: "add",
        scopes: ["fresh-scope"],
        receipt: recall.receipt,
      }),
      "MEMORY_FENCED_REPLAY"
    );
    await expectMemoryError(
      remember(harness, {
        text: "Finn enjoys locomotives.",
        decision: "add",
        derivedFrom: [recall.facts[0]!.uri],
      }),
      "MEMORY_FENCED_DERIVED"
    );
    const docs = await harness.store.listDocuments("memory");
    expect(docs.ok && docs.value.length).toBe(1);
  });

  test("supersede verifies predecessor hash, projects the relation, excludes the predecessor from recall", async () => {
    const recall = await harness.service.recall({
      ...IDENTITY,
      query: "trains",
      collection: "memory",
      scopes: SCOPE,
    });
    const predecessor = recall.facts[0]!;
    await expectMemoryError(
      remember(harness, {
        text: "Finn now prefers buses.",
        decision: "supersede",
        predecessorUri: predecessor.uri,
        predecessorHash: "0".repeat(64),
      }),
      "MEMORY_PREDECESSOR_HASH_MISMATCH"
    );
    const result = await remember(harness, {
      text: "Finn now prefers buses.",
      decision: "supersede",
      predecessorUri: predecessor.uri,
      predecessorHash: predecessor.contentHash,
    });
    expect(result.outcome).toBe("superseded");
    if (result.outcome !== "superseded") return;
    expect(result.record.supersedes).toEqual([predecessor.uri]);
    const successor = await harness.store.getDocumentByUri(result.record.uri);
    const edges = await harness.store.getEdgesForDoc(
      (successor as { value: { id: number } }).value.id,
      { edgeType: "supersedes" }
    );
    expect(edges.ok && edges.value.map((edge) => edge.targetUri)).toEqual([
      predecessor.uri,
    ]);
    const after = await harness.service.recall({
      ...IDENTITY,
      query: "Finn",
      collection: "memory",
      scopes: SCOPE,
    });
    expect(after.facts.map((fact) => fact.text)).toEqual([
      "Finn now prefers buses.",
    ]);
  });

  test("racing supersedes yield exactly one current record and one conflict", async () => {
    const recall = await harness.service.recall({
      ...IDENTITY,
      query: "buses",
      collection: "memory",
      scopes: SCOPE,
    });
    const predecessor = recall.facts[0]!;
    const race = (text: string) =>
      remember(harness, {
        text,
        decision: "supersede",
        predecessorUri: predecessor.uri,
        predecessorHash: predecessor.contentHash,
      });
    const outcomes = await Promise.allSettled([
      race("Finn prefers trams (writer A)."),
      race("Finn prefers ferries (writer B)."),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      MemoryError
    );
    expect(
      ((rejected[0] as PromiseRejectedResult).reason as MemoryError).code
    ).toBe("MEMORY_SUPERSEDE_CONFLICT");
    const current = await harness.service.recall({
      ...IDENTITY,
      query: "Finn prefers",
      collection: "memory",
      scopes: SCOPE,
    });
    expect(current.facts.length).toBe(1);
    expect(current.facts[0]!.text).toMatch(/writer [AB]/);
  });

  test("a caller that pre-holds the lease fails fast with a clear error (no nesting)", async () => {
    const held = await acquireWriteLock(harness.lockPath, 1_000);
    expect(held).not.toBeNull();
    try {
      const fast = new MemoryService({
        store: harness.store,
        config: harness.config,
        collections: harness.collections,
        lockPath: harness.lockPath,
        lockWaitMs: 500,
      });
      const error = await expectMemoryError(
        fast.remember({
          ...IDENTITY,
          collection: "memory",
          scopes: SCOPE,
          text: "Ivan likes puzzles.",
          decision: "add",
        }),
        "MEMORY_WRITE_LEASE_BUSY"
      );
      expect(error.message).toContain("callers must not pre-hold it");
    } finally {
      await held!.release();
    }
  });

  test("source evidence round-trips remember -> fact file -> recall", async () => {
    const source = "Said at dinner on 2026-09-01";
    const result = await remember(harness, {
      text: "Ivan's swimming lesson is on Tuesdays.",
      decision: "add",
      source: `  ${source}  `,
    });
    expect(result.outcome).toBe("added");
    if (result.outcome !== "added") return;
    expect(result.record.source).toBe(source);
    const content = await Bun.file(result.absPath).text();
    expect(content).toContain(`  source: "${source}"`);

    const recall = await harness.service.recall({
      ...IDENTITY,
      query: "swimming lesson",
      collection: "memory",
      scopes: SCOPE,
    });
    expect(recall.facts.map((fact) => fact.source)).toEqual([source]);

    // The idempotent duplicate echoes the persisted evidence, not the input.
    const duplicate = await remember(harness, {
      text: "Ivan's swimming lesson is on Tuesdays.",
      decision: "add",
    });
    expect(duplicate.outcome).toBe("existing");
    if (duplicate.outcome !== "existing") return;
    expect(duplicate.record.source).toBe(source);

    // A fact stored without evidence carries no `source` key at all.
    const bare = await remember(harness, {
      text: "Ivan's judo class is on Fridays.",
      decision: "add",
    });
    expect(bare.outcome).toBe("added");
    if (bare.outcome !== "added") return;
    expect("source" in bare.record).toBe(false);
    expect(await Bun.file(bare.absPath).text()).not.toContain("source:");
  });
});

describe("concurrent identical adds", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness("memory-concurrent-add");
  });

  afterAll(async () => {
    await harness.store.close();
    await safeRm(harness.root);
  });

  test("two racing adds of the same text write exactly one file and agree on the record", async () => {
    const text = "Finn's kindergarten starts at 08:30.";
    const [left, right] = await Promise.all([
      remember(harness, { text, decision: "add" }),
      remember(harness, { text, decision: "add" }),
    ]);
    const outcomes = [left.outcome, right.outcome].sort();
    expect(outcomes).toEqual(["added", "existing"]);
    if (left.outcome === "candidates" || right.outcome === "candidates") return;
    expect(left.record.recordId).toBe(right.record.recordId);
    expect(left.record.uri).toBe(right.record.uri);

    const files = await Array.fromAsync(
      new Bun.Glob("**/*.md").scan(join(harness.root, "memory"))
    );
    expect(files).toHaveLength(1);
    const docs = await harness.store.listDocuments("memory");
    expect(docs.ok && docs.value.length).toBe(1);
  });
});

describe("supersede edge projection", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness("memory-supersede-projection");
  });

  afterAll(async () => {
    await harness.store.close();
    await safeRm(harness.root);
  });

  test("a supersede whose edge fails to project is reported, not claimed", async () => {
    const added = await remember(harness, {
      text: "Ivan starts kindergarten in August.",
      decision: "add",
    });
    expect(added.outcome).toBe("added");
    if (added.outcome !== "added") return;

    // Same store, but typed-edge projection (frontmatter relations) fails.
    const failingStore = new Proxy(harness.store, {
      get(target, property, receiver) {
        if (property === "setDocEdges") {
          return async (docId: number, edges: unknown[], edgeSource: string) =>
            edgeSource === "frontmatter-relation"
              ? {
                  ok: false,
                  error: { code: "STORE_ERROR", message: "injected failure" },
                }
              : target.setDocEdges(docId, edges as never, edgeSource as never);
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failing = new MemoryService({
      store: failingStore,
      config: harness.config,
      collections: harness.collections,
      lockPath: harness.lockPath,
      lockWaitMs: 5_000,
    });
    const error = await expectMemoryError(
      failing.remember({
        ...IDENTITY,
        collection: "memory",
        scopes: SCOPE,
        text: "Ivan starts kindergarten in September.",
        decision: "supersede",
        predecessorUri: added.record.uri,
        predecessorHash: added.record.contentHash,
      }),
      "MEMORY_SUPERSEDE_PROJECTION_FAILED"
    );
    expect(error.message).toContain("injected failure");

    // Nothing claims the predecessor was replaced: it still reads as current.
    const recall = await harness.service.recall({
      ...IDENTITY,
      query: "kindergarten",
      collection: "memory",
      scopes: SCOPE,
    });
    expect(recall.facts.map((fact) => fact.uri)).toContain(added.record.uri);
  });
});

describe("retrieval-level scope and supersession filtering", () => {
  let harness: Harness;

  const uris: Record<string, string> = {};

  async function seed(text: string, scopes: string[]): Promise<string> {
    const result = await remember(harness, { text, decision: "add", scopes });
    if (result.outcome !== "added") throw new Error("expected added");
    uris[text] = result.record.uri;
    return result.record.uri;
  }

  beforeAll(async () => {
    harness = await createHarness("memory-filters");
    await seed("quarterly budget review moved to thursday", ["team-a"]);
    await seed("budget budget budget budget", ["team-b"]);
  });

  afterAll(async () => {
    await harness.store.close();
    await safeRm(harness.root);
  });

  test("an out-of-scope fact never occupies the candidate window", async () => {
    const unfiltered = await harness.store.searchFts("budget", {
      collection: "memory",
      limit: 1,
    });
    expect(unfiltered.ok && unfiltered.value.map((r) => r.uri)).toEqual([
      uris["budget budget budget budget"],
    ]);
    const filtered = await harness.store.searchFts("budget", {
      collection: "memory",
      limit: 1,
      memoryScopesAny: ["team-a"],
    });
    expect(filtered.ok && filtered.value.map((r) => r.uri)).toEqual([
      uris["quarterly budget review moved to thursday"],
    ]);
    const none = await harness.store.searchFts("budget", {
      collection: "memory",
      limit: 1,
      memoryScopesAny: ["team-c"],
    });
    expect(none.ok && none.value).toEqual([]);
    const eligible = await harness.store.listMemoryEligibleDocuments({
      collection: "memory",
      scopes: ["team-a", "team-c"],
    });
    expect(eligible.ok && eligible.value.length).toBe(1);
  });

  test("a window full of superseded facts still yields the current fact", async () => {
    const chain = [
      "alpha alpha alpha alpha alpha version one",
      "alpha alpha alpha alpha alpha version two",
      "alpha alpha alpha alpha alpha version three",
      "alpha version four",
    ];
    const chainUris: string[] = [];
    let previous = await remember(harness, {
      text: chain[0]!,
      decision: "add",
      scopes: ["chain"],
    });
    for (const text of chain.slice(1)) {
      if (previous.outcome !== "added" && previous.outcome !== "superseded") {
        throw new Error("expected a written record");
      }
      chainUris.push(previous.record.uri);
      previous = await remember(harness, {
        text,
        decision: "supersede",
        scopes: ["chain"],
        predecessorUri: previous.record.uri,
        predecessorHash: previous.record.contentHash,
      });
    }
    if (previous.outcome !== "superseded")
      throw new Error("expected superseded");
    chainUris.push(previous.record.uri);
    const window = await harness.store.searchFts("alpha", {
      collection: "memory",
      limit: 2,
      memoryScopesAny: ["chain"],
    });
    expect(window.ok && window.value.map((r) => r.uri)).toEqual([
      chainUris[0],
      chainUris[1],
    ]);
    const current = await harness.store.searchFts("alpha", {
      collection: "memory",
      limit: 2,
      memoryScopesAny: ["chain"],
      excludeSuperseded: true,
    });
    expect(current.ok && current.value.map((r) => r.uri)).toEqual([
      chainUris[3],
    ]);
    const recall = await harness.service.recall({
      ...IDENTITY,
      query: "alpha",
      collection: "memory",
      scopes: ["chain"],
    });
    expect(recall.facts.map((fact) => fact.text)).toEqual([
      "alpha version four",
    ]);
  });
});

describe("candidate-match determinism contract", () => {
  const corpus = [
    "The deploy window is Tuesday 09:00 UTC",
    "Deploy window: Tuesday at 09:00 UTC",
    "Ivan's favourite snack is apple slices",
    "Finn prefers the blue cup at breakfast",
    "Staging database resets every Sunday night",
    "Tuesday standup moved to the blue room",
  ];
  const incoming = "deploy window tuesday 09:00 utc";

  async function seeded(prefix: string, embedPort: EmbeddingPort | null) {
    const harness = await createHarness(prefix, { embedPort });
    for (const text of corpus) {
      const result = await remember(harness, {
        text,
        decision: "add",
        scopes: ["ops"],
      });
      expect(result.outcome).toBe("added");
    }
    return harness;
  }

  async function proposal(harness: Harness) {
    const result = await remember(harness, { text: incoming, scopes: ["ops"] });
    expect(result.outcome).toBe("candidates");
    if (result.outcome !== "candidates") throw new Error("unreachable");
    return JSON.stringify({
      matching: result.matching,
      candidates: result.candidates.map((c) => ({
        recordId: c.recordId,
        match: c.match,
        similarity: c.similarity,
        text: c.text,
      })),
    });
  }

  test("lexical fallback (Jaccard >= 0.5) is byte-identical across runs and says so", async () => {
    const harness = await seeded("memory-determinism-lexical", null);
    try {
      const first = await proposal(harness);
      expect(first).toBe(await proposal(harness));
      const parsed = JSON.parse(first);
      expect(parsed.matching).toEqual({
        mode: "lexical",
        threshold: 0.5,
        semanticUnavailable: "no embedding model available",
      });
      // Only facts sharing a token enter the BM25 pool; the rest never appear.
      expect(parsed.candidates.map((c: { match: string }) => c.match)).toEqual([
        "likely",
        "likely",
        "weak",
      ]);
    } finally {
      await harness.store.close();
      await safeRm(harness.root);
    }
  });

  test("semantic mode (cosine >= 0.83) is byte-identical across runs", async () => {
    const harness = await seeded(
      "memory-determinism-semantic",
      fakeEmbedPort()
    );
    try {
      const first = await proposal(harness);
      expect(first).toBe(await proposal(harness));
      const parsed = JSON.parse(first);
      expect(parsed.matching).toEqual({ mode: "semantic", threshold: 0.83 });
      expect(parsed.candidates[0].match).toBe("likely");
      expect(parsed.candidates.at(-1).match).toBe("weak");
    } finally {
      await harness.store.close();
      await safeRm(harness.root);
    }
  });
});

describe("malformed memory files", () => {
  let harness: Harness;
  const originalEnv = {
    configDir: process.env.GNO_CONFIG_DIR,
    dataDir: process.env.GNO_DATA_DIR,
    cacheDir: process.env.GNO_CACHE_DIR,
  };

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-memory-malformed-env-"));
    process.env.GNO_CONFIG_DIR = join(root, "config");
    process.env.GNO_DATA_DIR = join(root, "data");
    process.env.GNO_CACHE_DIR = join(root, "cache");
    const { getIndexDbPath } = await import("../../src/app/constants");
    harness = await createHarness("memory-malformed", {
      dbPath: getIndexDbPath(),
    });
    await mkdir(join(root, "config"), { recursive: true });
    await Bun.write(
      join(root, "config", "index.yml"),
      Bun.YAML.stringify(harness.config)
    );
    await remember(harness, {
      text: "A valid fact about robots.",
      decision: "add",
    });
    await Bun.write(
      join(harness.root, "memory", "facts", "hand-edited.md"),
      "---\ntitle: robots\nmemory:\n  recordId: broken\n  scopes: []\n---\n\nHand-edited robots note.\n"
    );
    await new SyncService().syncCollection(
      harness.collections[0]!,
      harness.store
    );
  });

  afterAll(async () => {
    await harness.store.close();
    await safeRm(harness.root);
    process.env.GNO_CONFIG_DIR = originalEnv.configDir;
    process.env.GNO_DATA_DIR = originalEnv.dataDir;
    process.env.GNO_CACHE_DIR = originalEnv.cacheDir;
  });

  test("excluded from managed recall but visible to ordinary retrieval", async () => {
    const recall = await harness.service.recall({
      ...IDENTITY,
      query: "robots",
      collection: "memory",
      scopes: SCOPE,
    });
    expect(recall.facts.map((fact) => fact.text)).toEqual([
      "A valid fact about robots.",
    ]);
    const search = await searchBm25(harness.store, "robots", {
      collection: "memory",
    });
    expect(search.ok && search.value.results.length).toBe(2);
  });

  test("status and audit project the diagnostic codes", async () => {
    const memoryStatus = await buildMemoryStatus(
      harness.store,
      harness.collections
    );
    expect(memoryStatus).toMatchObject({
      managedCollections: 1,
      records: 1,
      malformed: 1,
    });
    expect(memoryStatus.collections[0]?.malformedRecords[0]).toMatchObject({
      relPath: "facts/hand-edited.md",
      codes: [
        "MEMORY_RECORD_ID_INVALID",
        "MEMORY_SCOPES_EMPTY",
        "MEMORY_IDENTITY_MISSING",
        "MEMORY_CREATED_AT_INVALID",
        "MEMORY_CONTENT_HASH_INVALID",
      ],
    });
    const contribution = evaluateMemoryRecordAudit([
      {
        uri: "gno://memory/facts/hand-edited.md",
        relPath: "facts/hand-edited.md",
        captureSourceDeclared: false,
        memory: { content: "no frontmatter at all" },
        record: {},
      },
    ]);
    expect(contribution.status).toBe("fail");
    expect(contribution.findings?.[0]?.location).toBe(
      "MEMORY_FRONTMATTER_MISSING"
    );

    const live = await status({ json: true });
    expect(live).toMatchObject({ success: true });
    const json = JSON.parse(formatStatus(live, { json: true }));
    expect(json.memory.malformed).toBe(1);
    expect(json.memory.collections[0].malformedRecords[0].relPath).toBe(
      "facts/hand-edited.md"
    );
    expect(formatStatus(live, {})).toContain(
      "facts/hand-edited.md: MEMORY_RECORD_ID_INVALID"
    );

    const report = await audit({ category: "provenance" });
    expect(report.success).toBe(true);
    if (!report.success) return;
    const rule = report.report.rules.find(
      (item) => item.ruleId === "provenance.memory-record"
    );
    expect(rule?.status).toBe("fail");
    expect(
      report.report.findings
        .filter((finding) => finding.ruleId === "provenance.memory-record")
        .map((finding) => finding.location)
    ).toContain("MEMORY_RECORD_ID_INVALID");
  });
});
