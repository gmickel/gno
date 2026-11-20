/**
 * Bounded embed runs: `limits` stop a verified variant pass at a batch
 * boundary, keep committed batches, skip activation, and the next pass
 * continues where the last one stopped.
 */

import type { Database as DatabaseType } from "bun:sqlite";

import { Database } from "bun:sqlite";
import { afterEach, expect, mock, spyOn, test } from "bun:test";

import type { EmbedBacklogDeps } from "../../src/embed/backlog";
import type { EmbeddingPort } from "../../src/llm/types";
import type { VectorIndexPort } from "../../src/store/vector";

import { embedStageOutcome, formatEmbed } from "../../src/cli/commands/embed";
import { embedBacklog } from "../../src/embed/backlog";
import { countVariantBacklog } from "../../src/embed/variant-plan";
import { migration } from "../../src/store/migrations/028-vector-variants";
import { migration as runtimeMigration } from "../../src/store/migrations/031-runtime-independent-vectors";
import { createVectorStatsPort } from "../../src/store/vector/stats";
import { createVectorVariantStore } from "../../src/store/vector/variants";

const databases: DatabaseType[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** `docs` chunks in collection `docs`, plus `other` chunks in `other`. */
async function limitsFixture(docs = 10, other = 0, delayMs = 0) {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE documents(id INTEGER PRIMARY KEY, mirror_hash TEXT, title TEXT, active INTEGER, collection TEXT);
    CREATE TABLE content_chunks(mirror_hash TEXT, seq INTEGER, text TEXT, PRIMARY KEY(mirror_hash, seq));
    CREATE TABLE content_vectors(mirror_hash TEXT, seq INTEGER, model TEXT, embedding BLOB);`);
  let id = 0;
  const add = (collection: string, count: number) => {
    for (let i = 0; i < count; i++) {
      id++;
      db.run("INSERT INTO documents VALUES (?, ?, ?, 1, ?)", [
        id,
        `m${id}`,
        `Doc ${id}`,
        collection,
      ]);
      db.run("INSERT INTO content_chunks VALUES (?, 0, ?)", [
        `m${id}`,
        `body ${id}`,
      ]);
    }
  };
  add("docs", docs);
  add("other", other);
  migration.up(db, "unicode61");
  runtimeMigration.up(db, "unicode61");
  const store = await createVectorVariantStore(db, {
    model: "test-model",
    modelFingerprint: "actual-test-weights",
    contextSize: 512,
    truncationPolicy: "test-tail-v1",
    dimensions: 3,
  });
  const embedBatch = mock(async (texts: string[]) => {
    if (delayMs) await Bun.sleep(delayMs);
    return { ok: true as const, value: texts.map(() => [0.1, 0.2, 0.3]) };
  });
  const deps: EmbedBacklogDeps = {
    statsPort: createVectorStatsPort(db),
    embedPort: {
      embedBatch,
      embed: mock(() => Promise.resolve({ ok: true, value: [0.1, 0.2, 0.3] })),
      dimensions: () => 3,
      init: () => Promise.resolve({ ok: true }),
      dispose: () => Promise.resolve(),
      modelUri: "test-model",
    } as unknown as EmbeddingPort,
    vectorIndex: {
      searchAvailable: true,
      model: "test-model",
      dimensions: 3,
      vecDirty: false,
    } as unknown as VectorIndexPort,
    modelUri: "test-model",
    variantStore: store,
    identityStillCurrent: () => true,
  };
  return { db, store, deps, embedBatch };
}

test("--max-chunks stops after the batch that reaches it; the next run continues", async () => {
  const { store, deps, embedBatch } = await limitsFixture(10);
  const activate = spyOn(store, "activate");

  const first = await embedBacklog({
    ...deps,
    batchSize: 4,
    limits: { maxChunks: 5 },
  });
  // Whole batches: 4 + 4 crosses 5, so 8 are embedded.
  expect(first).toEqual({
    ok: true,
    value: { embedded: 8, errors: 0, contentionErrors: 0, stopped: "limit" },
  });
  expect(embedBatch).toHaveBeenCalledTimes(2);
  expect(countVariantBacklog(deps)).toBe(2);
  expect(activate).not.toHaveBeenCalled();
  expect(store.hasActivated()).toBe(false);

  const second = await embedBacklog({
    ...deps,
    batchSize: 4,
    limits: { maxChunks: 5 },
  });
  expect(second).toEqual({
    ok: true,
    value: { embedded: 2, errors: 0, contentionErrors: 0 },
  });
  expect(countVariantBacklog(deps)).toBe(0);
  expect(store.hasActivated()).toBe(true);
});

test("a limit reached on the last batch is a finished pass", async () => {
  const { store, deps } = await limitsFixture(8);
  const result = await embedBacklog({
    ...deps,
    batchSize: 4,
    limits: { maxChunks: 8 },
  });
  expect(result).toEqual({
    ok: true,
    value: { embedded: 8, errors: 0, contentionErrors: 0 },
  });
  expect(store.hasActivated()).toBe(true);
});

test("--max-chunks counts only the scoped collection's backlog", async () => {
  const { deps } = await limitsFixture(6, 20);
  const result = await embedBacklog({
    ...deps,
    collection: "docs",
    batchSize: 2,
    limits: { maxChunks: 3 },
  });
  expect(result).toMatchObject({
    ok: true,
    value: { embedded: 4, stopped: "limit" },
  });
  expect(countVariantBacklog({ ...deps, collection: "docs" })).toBe(2);
  expect(countVariantBacklog({ ...deps, collection: "other" })).toBe(20);
});

test("--max-seconds stops at a batch boundary once the time is spent", async () => {
  const { store, deps, embedBatch } = await limitsFixture(12, 0, 40);
  const result = await embedBacklog({
    ...deps,
    batchSize: 2,
    limits: { maxSeconds: 0.05 },
  });
  expect(result).toMatchObject({ ok: true, value: { stopped: "limit" } });
  const value = result.ok ? result.value : undefined;
  // At least one batch, never a partial one, and work is left.
  expect(embedBatch.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(embedBatch.mock.calls.length).toBeLessThan(6);
  expect(value?.embedded).toBe(embedBatch.mock.calls.length * 2);
  expect(countVariantBacklog(deps)).toBe(12 - (value?.embedded ?? 0));
  expect(store.hasActivated()).toBe(false);
});

test("a limit-stopped run reports a finished stage, never a crash marker", () => {
  expect(
    embedStageOutcome({
      success: true,
      embedded: 8,
      errors: 0,
      contentionErrors: 0,
      duration: 1,
      model: "m",
      searchAvailable: true,
      remaining: 2,
      stopped: "limit",
    })
  ).toBe("completed");
});

test("JSON receipt carries remaining and stopped; the human line says how many remain", () => {
  const result = {
    success: true as const,
    embedded: 8,
    errors: 0,
    contentionErrors: 0,
    duration: 1.5,
    model: "test-model",
    searchAvailable: true,
    errorSamples: [],
    remaining: 1234,
    stopped: "limit" as const,
  };
  expect(JSON.parse(formatEmbed(result, { json: true }))).toEqual({
    embedded: 8,
    errors: 0,
    contentionErrors: 0,
    duration: 1.5,
    model: "test-model",
    searchAvailable: true,
    errorSamples: [],
    remaining: 1234,
    stopped: "limit",
  });
  expect(formatEmbed(result, {})).toContain(
    "Stopped at the run limit; 1,234 chunks remaining."
  );

  const finished = JSON.parse(
    formatEmbed(
      { ...result, embedded: 2, remaining: 0, stopped: undefined },
      { json: true }
    )
  );
  expect(finished.remaining).toBe(0);
  expect(finished).not.toHaveProperty("stopped");
});

test("a runtime identity change ends the pass as incomplete so the CLI recounts", async () => {
  const { deps } = await limitsFixture(6);
  let checks = 0;
  const result = await embedBacklog({
    ...deps,
    batchSize: 2,
    // Current for the first page, then the runtime changes.
    identityStillCurrent: () => ++checks <= 3,
  });
  expect(result).toMatchObject({ ok: true, value: { incomplete: true } });
  expect(countVariantBacklog(deps)).toBeGreaterThan(0);
});

test("limit values must be positive whole numbers", async () => {
  const { parseRunLimit } = await import("../../src/cli/options");
  expect(parseRunLimit("max-chunks", undefined)).toBeUndefined();
  expect(parseRunLimit("max-chunks", "5000")).toBe(5000);
  for (const bad of ["0", "-3", "2.9", "1e3", "7junk", "", "9007199254740993"])
    expect(() => parseRunLimit("max-chunks", bad)).toThrow(
      "--max-chunks must be a positive whole number"
    );
});

/** Fails every input containing "poison", in batches and one at a time. */
function poisonPort(deps: EmbedBacklogDeps) {
  const vector = [0.1, 0.2, 0.3];
  const embedded: string[] = [];
  deps.embedPort.embedBatch = mock(async (texts: string[]) => {
    if (texts.some((text) => text.includes("poison")))
      return { ok: false as const, error: { code: "MODEL", message: "bad" } };
    embedded.push(...texts);
    return { ok: true as const, value: texts.map(() => vector) };
  }) as never;
  deps.embedPort.embed = mock(async (text: string) => {
    if (text.includes("poison"))
      return { ok: false as const, error: { code: "MODEL", message: "bad" } };
    embedded.push(text);
    return { ok: true as const, value: vector };
  }) as never;
  return embedded;
}

test("a chunk that keeps failing does not block later chunks across bounded runs", async () => {
  const { db, deps } = await limitsFixture(4);
  db.run("UPDATE content_chunks SET text = 'poison' WHERE mirror_hash = 'm1'");
  poisonPort(deps);
  const bounded = { ...deps, batchSize: 1, limits: { maxChunks: 1 } };

  // Run 1 attempts the failing first chunk and stops at the limit.
  expect(await embedBacklog(bounded)).toMatchObject({
    ok: true,
    value: { embedded: 0, errors: 1, stopped: "limit" },
  });
  // Later runs resume after it instead of retrying it first.
  expect(await embedBacklog(bounded)).toMatchObject({
    ok: true,
    value: { embedded: 1, stopped: "limit" },
  });
  expect(await embedBacklog(bounded)).toMatchObject({
    ok: true,
    value: { embedded: 1, stopped: "limit" },
  });
  expect(countVariantBacklog(deps)).toBe(2);
  // The fourth chunk, then the run wraps to the failing chunk, which stays pending.
  const last = await embedBacklog({ ...bounded, limits: { maxChunks: 10 } });
  expect(last).toMatchObject({ ok: true, value: { embedded: 1, errors: 1 } });
  expect(countVariantBacklog(deps)).toBe(1);
  // A pass that reached its end clears the resume position.
  expect(
    db
      .query(
        "SELECT count(*) AS n FROM schema_meta WHERE key LIKE 'embed_resume_cursor:%'"
      )
      .get()
  ).toEqual({ n: 0 });
});

test("a runtime change during the batch that reaches the limit is incomplete, not a limit stop", async () => {
  const { deps, embedBatch } = await limitsFixture(6);
  let current = true;
  embedBatch.mockImplementation(async (texts: string[]) => {
    current = false;
    return { ok: true as const, value: texts.map(() => [0.1, 0.2, 0.3]) };
  });
  const result = await embedBacklog({
    ...deps,
    batchSize: 2,
    limits: { maxChunks: 2 },
    identityStillCurrent: () => current,
  });
  expect(result.ok).toBe(true);
  const value = result.ok ? result.value : undefined;
  expect(value?.incomplete).toBe(true);
  expect(value?.stopped).toBeUndefined();
});

test("a port that drops its identity on failure still lets later chunks progress", async () => {
  const { db, deps } = await limitsFixture(3);
  db.run("UPDATE content_chunks SET text = 'poison' WHERE mirror_hash = 'm1'");
  poisonPort(deps);
  // Native-style: a failed request drops the cached identity until init().
  let identity = true;
  const batch = deps.embedPort.embedBatch.bind(deps.embedPort);
  deps.embedPort.embedBatch = (async (texts: string[], options?: unknown) => {
    const result = await batch(texts, options as never);
    if (!result.ok) identity = false;
    return result;
  }) as never;
  const single = deps.embedPort.embed.bind(deps.embedPort);
  deps.embedPort.embed = (async (text: string, options?: unknown) => {
    const result = await single(text, options as never);
    if (!result.ok) identity = false;
    return result;
  }) as never;
  deps.embedPort.init = (async () => {
    identity = true;
    return { ok: true };
  }) as never;
  const bounded = {
    ...deps,
    batchSize: 1,
    limits: { maxChunks: 1 },
    identityStillCurrent: () => identity,
  };
  const first = await embedBacklog(bounded);
  expect(first).toMatchObject({ ok: true, value: { stopped: "limit" } });
  expect(first.ok && first.value.incomplete).toBeFalsy();
  expect(await embedBacklog(bounded)).toMatchObject({
    ok: true,
    value: { embedded: 1 },
  });
  expect(countVariantBacklog(deps)).toBe(2);
});

test("no retry batch starts once a limit is reached", async () => {
  const { db, deps } = await limitsFixture(4);
  db.run("UPDATE content_chunks SET text = 'poison' WHERE mirror_hash = 'm1'");
  poisonPort(deps);
  const poisonCalls = () =>
    [
      ...(deps.embedPort.embedBatch as ReturnType<typeof mock>).mock.calls.map(
        (call) => call[0] as string[]
      ),
      ...(deps.embedPort.embed as ReturnType<typeof mock>).mock.calls.map(
        (call) => [call[0] as string]
      ),
    ].filter((texts) => texts.some((text) => text.includes("poison"))).length;
  const unbounded = await limitsFixture(4);
  unbounded.db.run(
    "UPDATE content_chunks SET text = 'poison' WHERE mirror_hash = 'm1'"
  );
  poisonPort(unbounded.deps);
  await embedBacklog({ ...unbounded.deps, batchSize: 2 });
  const unboundedPoison = [
    ...(unbounded.deps.embedPort.embedBatch as ReturnType<typeof mock>).mock
      .calls,
    ...(unbounded.deps.embedPort.embed as ReturnType<typeof mock>).mock.calls,
  ].filter((call) => JSON.stringify(call[0]).includes("poison")).length;

  const result = await embedBacklog({
    ...deps,
    batchSize: 2,
    limits: { maxChunks: 2 },
  });
  expect(result).toMatchObject({ ok: true, value: { stopped: "limit" } });
  // Fewer attempts at the failing chunk than a pass that retries it.
  expect(poisonCalls()).toBeLessThan(unboundedPoison);
});

test("the receipt and human output surface a runtime change", () => {
  const result = {
    success: true as const,
    embedded: 0,
    errors: 0,
    contentionErrors: 0,
    duration: 0.2,
    model: "test-model",
    searchAvailable: true,
    errorSamples: [],
    remaining: 6,
    incomplete: true,
  };
  expect(JSON.parse(formatEmbed(result, { json: true }))).toMatchObject({
    incomplete: true,
    remaining: 6,
  });
  const human = formatEmbed(result, {});
  expect(human).not.toContain("All up to date");
  expect(human).toContain(
    "Stopped early because the embedding runtime changed; 6 chunks remaining."
  );
});
