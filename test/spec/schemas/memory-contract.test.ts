/**
 * Cross-surface memory contract: the core MemoryService, REST
 * (POST /api/memory/remember + /api/memory/recall) and the SDK
 * (client.remember() / client.recall()) emit the same result shapes for the
 * same inputs, validate against the shared output schemas, and map errors to
 * the same stable memory codes. CLI --json and MCP adapters bind to the same
 * core types and are checked against the same schemas in their own suites.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for mkdtemp/mkdir)
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Collection, Config } from "../../../src/config/types";
import type { RecallInput, RememberInput } from "../../../src/core/memory";
import type { GnoClient } from "../../../src/sdk";
import type { ContextHolder } from "../../../src/serve/routes/api";

import { ENV_DATA_DIR } from "../../../src/app/constants";
import { createDefaultConfig } from "../../../src/config/defaults";
import { MemoryError, MemoryService } from "../../../src/core/memory";
import { createGnoClient, GnoSdkError } from "../../../src/sdk";
import {
  handleMemoryRecall,
  handleMemoryRemember,
} from "../../../src/serve/routes/api";
import { startServer } from "../../../src/serve/server";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { safeRm } from "../../helpers/cleanup";
import { assertValid, loadSchema } from "./validator";

const IDENTITY = { caller: "codex", session: "session-1" };
const SCOPES = ["project:gno"];
const COLLECTION = "memory";

type SurfaceError = { code: string };
type SurfaceOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: SurfaceError };

interface Surface {
  name: string;
  remember(input: RememberInput): Promise<SurfaceOutcome>;
  recall(input: RecallInput): Promise<SurfaceOutcome>;
  close(): Promise<void>;
}

/** Fields that legitimately differ per index/run (time, ids, paths). */
const VOLATILE = new Set([
  "uri",
  "docid",
  "recordId",
  "absPath",
  "createdAt",
  "issuedAt",
  "digest",
  "memoryIds",
  "supersedes",
]);

function normalizeVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeVolatile);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        VOLATILE.has(key) ? `<${key}>` : normalizeVolatile(item),
      ])
    );
  }
  return value;
}

async function createIndexRoot(prefix: string): Promise<{
  root: string;
  collections: Collection[];
  config: Config;
}> {
  const root = await mkdtemp(join(tmpdir(), `gno-memory-contract-${prefix}-`));
  await mkdir(join(root, COLLECTION), { recursive: true });
  await mkdir(join(root, "notes"), { recursive: true });
  const collections: Collection[] = [
    {
      name: COLLECTION,
      path: join(root, COLLECTION),
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
  return { root, collections, config };
}

async function openStore(root: string, config: Config): Promise<SqliteAdapter> {
  const store = new SqliteAdapter();
  const opened = await store.open(
    join(root, "index.sqlite"),
    config.ftsTokenizer
  );
  expect(opened.ok).toBe(true);
  expect((await store.syncCollections(config.collections)).ok).toBe(true);
  return store;
}

async function coreSurface(): Promise<Surface & { root: string }> {
  const { root, collections, config } = await createIndexRoot("core");
  const store = await openStore(root, config);
  const service = new MemoryService({
    store,
    config,
    collections,
    lockPath: join(root, ".mcp-write.lock"),
    lockWaitMs: 5_000,
  });
  const wrap = async (run: () => Promise<unknown>): Promise<SurfaceOutcome> => {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      if (error instanceof MemoryError) {
        return { ok: false, error: { code: error.code } };
      }
      throw error;
    }
  };
  return {
    name: "core",
    root,
    remember: (input) => wrap(() => service.remember(input)),
    recall: (input) => wrap(() => service.recall(input)),
    close: () => store.close(),
  };
}

function restContextHolder(
  config: Config,
  store: SqliteAdapter
): ContextHolder {
  return {
    current: {
      config,
      store,
      indexName: "default",
      vectorIndex: null,
      embedPort: null,
      expandPort: null,
      answerPort: null,
      rerankPort: null,
      capabilities: { bm25: true, vector: false, hybrid: false, answer: false },
    },
    config,
    scheduler: null,
    eventBus: null,
    watchService: null,
  };
}

async function restSurface(): Promise<
  Surface & {
    root: string;
    store: SqliteAdapter;
    ctxHolder: ContextHolder;
    statuses: number[];
  }
> {
  const { root, config } = await createIndexRoot("rest");
  const store = await openStore(root, config);
  const ctxHolder = restContextHolder(config, store);
  const deps = { lockPath: join(root, ".mcp-write.lock"), lockWaitMs: 5_000 };
  const statuses: number[] = [];
  const call = async (
    path: string,
    body: unknown,
    handler: typeof handleMemoryRemember
  ): Promise<SurfaceOutcome> => {
    const req = new Request(`http://localhost${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const res = await handler(ctxHolder, store, req, deps);
    statuses.push(res.status);
    const json = (await res.json()) as { error?: SurfaceError };
    if (res.status >= 400) {
      expect(json.error?.code).toBeString();
      return { ok: false, error: { code: json.error?.code ?? "" } };
    }
    return { ok: true, value: json };
  };
  return {
    name: "rest",
    root,
    store,
    ctxHolder,
    statuses,
    remember: (input) =>
      call("/api/memory/remember", input, handleMemoryRemember),
    recall: (input) => call("/api/memory/recall", input, handleMemoryRecall),
    close: () => store.close(),
  };
}

async function sdkSurface(): Promise<
  Surface & { root: string; client: GnoClient }
> {
  const { root, config } = await createIndexRoot("sdk");
  // Empty model cache + offline policy: no embedding port, so every surface
  // in this file runs lexical-only and the results are value-comparable.
  const client = await createGnoClient({
    config,
    dbPath: join(root, "index.sqlite"),
    cacheDir: join(root, "cache"),
    downloadPolicy: { offline: true, allowDownload: false },
  });
  const wrap = async (run: () => Promise<unknown>): Promise<SurfaceOutcome> => {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      if (error instanceof GnoSdkError) {
        expect(error.cause).toBeInstanceOf(MemoryError);
        return { ok: false, error: { code: String(error.details?.code) } };
      }
      throw error;
    }
  };
  return {
    name: "sdk",
    root,
    client,
    remember: (input) => wrap(() => client.remember(input)),
    recall: (input) => wrap(() => client.recall(input)),
    close: () => client.close(),
  };
}

function rememberInput(
  overrides: Partial<RememberInput> & { text: string }
): RememberInput {
  return { ...IDENTITY, collection: COLLECTION, scopes: SCOPES, ...overrides };
}

function recallInput(
  overrides: Partial<RecallInput> & { query: string }
): RecallInput {
  return { ...IDENTITY, collection: COLLECTION, scopes: SCOPES, ...overrides };
}

function expectIdentical(outcomes: SurfaceOutcome[]): unknown {
  const [reference, ...rest] = outcomes.map(normalizeVolatile);
  for (const outcome of rest) expect(outcome).toEqual(reference);
  return reference;
}

describe("memory cross-surface contract (core / REST / SDK)", () => {
  let rememberSchema: object;
  let recallSchema: object;
  let core: Awaited<ReturnType<typeof coreSurface>>;
  let rest: Awaited<ReturnType<typeof restSurface>>;
  let sdk: Awaited<ReturnType<typeof sdkSurface>>;
  let surfaces: Surface[];

  beforeAll(async () => {
    rememberSchema = await loadSchema("memory-remember");
    recallSchema = await loadSchema("memory-recall");
    [core, rest, sdk] = await Promise.all([
      coreSurface(),
      restSurface(),
      sdkSurface(),
    ]);
    surfaces = [core, rest, sdk];
  });

  afterAll(async () => {
    for (const surface of surfaces ?? []) await surface.close();
    await Promise.all(
      [core, rest, sdk].filter(Boolean).map((surface) => safeRm(surface.root))
    );
  });

  async function onAll(
    run: (surface: Surface) => Promise<SurfaceOutcome>
  ): Promise<SurfaceOutcome[]> {
    const outcomes: SurfaceOutcome[] = [];
    for (const surface of surfaces) outcomes.push(await run(surface));
    return outcomes;
  }

  test("empty recall: identical shape, hint present, schema-valid on every surface", async () => {
    const outcomes = await onAll((surface) =>
      surface.recall(recallInput({ query: "trains" }))
    );
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      expect(assertValid(outcome.value, recallSchema)).toBe(true);
      expect((outcome.value as { hint?: string }).hint).toContain(
        "gno remember"
      );
    }
    expectIdentical(outcomes);
  });

  test("remember add: identical shape, schema-valid, immediately recallable with lineage + receipt", async () => {
    const added = await onAll((surface) =>
      surface.remember(
        rememberInput({ text: "Finn likes trains.", decision: "add" })
      )
    );
    for (const outcome of added) {
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      expect(assertValid(outcome.value, rememberSchema)).toBe(true);
      expect((outcome.value as { outcome: string }).outcome).toBe("added");
    }
    expectIdentical(added);
    expect(rest.statuses.at(-1)).toBe(201);

    const recalled = await onAll((surface) =>
      surface.recall(recallInput({ query: "trains" }))
    );
    for (const outcome of recalled) {
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      expect(assertValid(outcome.value, recallSchema)).toBe(true);
      const value = outcome.value as {
        facts: Array<{
          uri: string;
          egressLineage: { effectivePolicy: string };
        }>;
        receipt: { caller: string; session: string; spanHashes: string[] };
        egressLineage?: { effectivePolicy: string };
        hint?: string;
      };
      expect(value.facts).toHaveLength(1);
      expect(value.facts[0]?.uri).toStartWith(`gno://${COLLECTION}/`);
      expect(value.facts[0]?.egressLineage.effectivePolicy).toBe("local_only");
      expect(value.egressLineage?.effectivePolicy).toBe("local_only");
      expect(value.receipt).toMatchObject(IDENTITY);
      expect(value.receipt.spanHashes).toHaveLength(1);
      expect(value.hint).toBeUndefined();
    }
    expectIdentical(recalled);
    expect(rest.statuses.at(-1)).toBe(200);
  });

  test("remember exact duplicate: 'existing' on every surface (REST 200)", async () => {
    const outcomes = await onAll((surface) =>
      surface.remember(
        rememberInput({ text: "Finn likes trains.", decision: "add" })
      )
    );
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      expect(assertValid(outcome.value, rememberSchema)).toBe(true);
      expect((outcome.value as { outcome: string }).outcome).toBe("existing");
    }
    expectIdentical(outcomes);
    expect(rest.statuses.at(-1)).toBe(200);
  });

  test("remember without a decision: candidates, nothing written", async () => {
    const outcomes = await onAll((surface) =>
      surface.remember(rememberInput({ text: "Finn likes trains a lot." }))
    );
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      expect(assertValid(outcome.value, rememberSchema)).toBe(true);
      const value = outcome.value as {
        outcome: string;
        candidates: Array<{ match: string }>;
      };
      expect(value.outcome).toBe("candidates");
      expect(value.candidates[0]?.match).toBe("likely");
    }
    expectIdentical(outcomes);
  });

  test.each([
    [
      "unscoped remember",
      "remember",
      { text: "x", scopes: [] },
      "MEMORY_SCOPES_REQUIRED",
      400,
    ],
    [
      "unscoped recall",
      "recall",
      { query: "x", scopes: [] },
      "MEMORY_SCOPES_REQUIRED",
      400,
    ],
    [
      "missing identity",
      "recall",
      { query: "x", session: "" },
      "MEMORY_IDENTITY_REQUIRED",
      400,
    ],
    [
      "zero budget",
      "recall",
      { query: "x", maxFacts: 0 },
      "MEMORY_BUDGET_INVALID",
      400,
    ],
    [
      "unmanaged collection",
      "remember",
      { text: "x", collection: "notes", decision: "add" as const },
      "MEMORY_COLLECTION_UNMANAGED",
      400,
    ],
    [
      "unknown collection",
      "recall",
      { query: "x", collection: "nope" },
      "MEMORY_COLLECTION_NOT_FOUND",
      404,
    ],
    [
      "supersede without predecessor",
      "remember",
      { text: "x", decision: "supersede" as const },
      "MEMORY_PREDECESSOR_REQUIRED",
      400,
    ],
  ])(
    "%s fails with the same code on every surface",
    async (_label, op, overrides, code, status) => {
      const outcomes = await onAll((surface) =>
        op === "remember"
          ? surface.remember(rememberInput(overrides as RememberInput))
          : surface.recall(recallInput(overrides as RecallInput))
      );
      for (const outcome of outcomes) {
        expect(outcome.ok).toBe(false);
        if (outcome.ok) continue;
        expect(outcome.error.code).toBe(code);
      }
      expect(rest.statuses.at(-1)).toBe(status);
    }
  );

  test("REST rejects a malformed body before reaching the service", async () => {
    const req = new Request("http://localhost/api/memory/remember", {
      method: "POST",
      body: "{not json",
    });
    const res = await handleMemoryRemember(rest.ctxHolder, rest.store, req);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: SurfaceError }).error.code).toBe(
      "VALIDATION"
    );

    const listReq = new Request("http://localhost/api/memory/recall", {
      method: "POST",
      body: JSON.stringify([1, 2]),
    });
    const listRes = await handleMemoryRecall(
      rest.ctxHolder,
      rest.store,
      listReq
    );
    expect(listRes.status).toBe(400);
  });

  test("production server routes gate memory on CSRF origin, then reach the service", async () => {
    const port = 3999;
    type RouteTable = Record<
      string,
      { POST?: (req: Request) => Response | Promise<Response> }
    >;
    let routes: RouteTable | undefined;
    // The same runtime shape startServer reads plus the resident-read
    // hooks the recall route goes through (handleResidentRead).
    const runtime = {
      config: rest.ctxHolder.config,
      store: rest.store,
      ctxHolder: rest.ctxHolder,
      actualConfigPath: join(rest.root, "index.yml"),
      dispose: async () => undefined,
      admitRequest: () => ({
        signal: new AbortController().signal,
        finish: () => undefined,
        authorizationEpoch: "epoch-1",
        isAuthorizationEpochCurrent: () => true,
      }),
      readerGate: { acquire: async () => () => undefined },
      withModelLease: <T>(operation: () => Promise<T>) => operation(),
    };
    const body = {
      ...IDENTITY,
      collection: COLLECTION,
      scopes: [],
      text: "x",
      query: "x",
    };
    const post = async (
      path: string,
      headers: Record<string, string>
    ): Promise<{ status: number; code: string }> => {
      const route = routes?.[path]?.POST;
      if (!route) throw new Error(`${path} not mounted by the server`);
      const res = await route(
        new Request(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        })
      );
      const json = (await res.json()) as { error: SurfaceError };
      return { status: res.status, code: json.error.code };
    };

    // Keep the route's default lease path inside the fixture root.
    const previousDataDir = process.env[ENV_DATA_DIR];
    process.env[ENV_DATA_DIR] = join(rest.root, "data");
    try {
      const result = await startServer(
        { port },
        {
          startBackgroundRuntime: (async () => ({
            success: true as const,
            runtime,
          })) as never,
          createMcpHttpGateway: (async () => ({
            route: async () => new Response("ok"),
            close: async () => undefined,
            security: {},
            transport: {},
          })) as never,
          createClipperRouteGateway: (() => ({ routes: {} })) as never,
          serve: ((options: { routes: RouteTable }) => {
            routes = options.routes;
            return { port, stop: async () => undefined } as never;
          }) as never,
          waitForShutdown: async () => {
            for (const path of ["/api/memory/remember", "/api/memory/recall"]) {
              // Cross-origin browser request from a foreign origin: refused
              // before the handler runs.
              expect(
                await post(path, { Origin: "http://evil.example" })
              ).toEqual({
                status: 403,
                code: "CSRF_VIOLATION",
              });
              // Loopback origin on the bound port, and no Origin at all
              // (curl / same-origin): both reach the service, whose own
              // validation answers with the stable memory code.
              const allowed: Array<Record<string, string>> = [
                { Origin: `http://127.0.0.1:${port}` },
                {},
              ];
              for (const headers of allowed) {
                expect(await post(path, headers)).toEqual({
                  status: 400,
                  code: "MEMORY_SCOPES_REQUIRED",
                });
              }
            }
          },
        }
      );
      expect(result).toEqual({ success: true });
    } finally {
      if (previousDataDir === undefined) delete process.env[ENV_DATA_DIR];
      else process.env[ENV_DATA_DIR] = previousDataDir;
    }
  });

  test("SDK round-trip: add -> recall -> supersede -> recall shows only the successor", async () => {
    const { client } = sdk;
    const added = await client.remember(
      rememberInput({
        text: "Ivan starts kindergarten in August.",
        decision: "add",
      })
    );
    expect(added.outcome).toBe("added");
    if (added.outcome !== "added") return;

    const before = await client.recall(recallInput({ query: "kindergarten" }));
    expect(before.facts.map((fact) => fact.uri)).toContain(added.record.uri);

    const superseded = await client.remember(
      rememberInput({
        text: "Ivan starts kindergarten in September.",
        decision: "supersede",
        predecessorUri: added.record.uri,
        predecessorHash: added.record.contentHash,
      })
    );
    expect(superseded.outcome).toBe("superseded");
    if (superseded.outcome !== "superseded") return;
    expect(superseded.record.supersedes).toEqual([added.record.uri]);
    expect(assertValid(superseded, rememberSchema)).toBe(true);

    const after = await client.recall(recallInput({ query: "kindergarten" }));
    expect(assertValid(after, recallSchema)).toBe(true);
    const uris = after.facts.map((fact) => fact.uri);
    expect(uris).toContain(superseded.record.uri);
    expect(uris).not.toContain(added.record.uri);

    const conflict = await sdk.remember(
      rememberInput({
        text: "Ivan starts kindergarten in October.",
        decision: "supersede",
        predecessorUri: added.record.uri,
        predecessorHash: added.record.contentHash,
      })
    );
    expect(conflict).toEqual({
      ok: false,
      error: { code: "MEMORY_SUPERSEDE_CONFLICT" },
    });
  });

  test("fence: replaying a receipted span is rejected on REST and SDK alike", async () => {
    const outcomes = await onAll(async (surface) => {
      const recalled = await surface.recall(recallInput({ query: "trains" }));
      expect(recalled.ok).toBe(true);
      if (!recalled.ok) return recalled;
      const value = recalled.value as {
        facts: Array<{ text: string }>;
        receipt: RememberInput["receipt"];
      };
      return surface.remember(
        rememberInput({
          text: value.facts[0]?.text ?? "",
          decision: "add",
          receipt: value.receipt,
        })
      );
    });
    for (const outcome of outcomes) {
      expect(outcome).toEqual({
        ok: false,
        error: { code: "MEMORY_FENCED_REPLAY" },
      });
    }
    expect(rest.statuses.at(-1)).toBe(400);
  });
});
