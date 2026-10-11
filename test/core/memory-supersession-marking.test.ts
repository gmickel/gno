/**
 * A memory fact that a newer fact superseded stays findable through ordinary
 * retrieval, but every output names its current successor, the answer prompt
 * says not to present it as current, and a Capsule citing it is stale.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
// node:fs/promises for mkdir/mkdtemp (filesystem structure ops)
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { ContextCapsuleV1 } from "../../src/core/context-capsule";
import type { AskResult } from "../../src/pipeline/types";

import {
  decorateResultUris,
  decorateUriForIndex,
} from "../../src/app/constants";
import {
  buildContextCapsule,
  verifyContextCapsuleRuntime,
} from "../../src/app/context-runtime";
import { formatAsk } from "../../src/cli/commands/ask-format";
import { formatSearchResults } from "../../src/cli/format/search-results";
import { createDefaultConfig } from "../../src/config/defaults";
import { MemoryService } from "../../src/core/memory";
import { generateGroundedAnswer } from "../../src/pipeline/answer";
import { searchBm25 } from "../../src/pipeline/search";
import { getDocumentByRef } from "../../src/sdk/documents";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { err } from "../../src/store/types";
import { safeRm } from "../helpers/cleanup";

const IDENTITY = { caller: "codex", session: "session-1" };
const SCOPES = ["project:gno"];

let root: string;
let store: SqliteAdapter;
let config: ReturnType<typeof createDefaultConfig> & {
  collections: Collection[];
};
let service: MemoryService;
let original: string;
let latest: string;
let capsuleBefore: ContextCapsuleV1;
const deps = () => ({ store, config, indexName: "default" });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-supersession-"));
  await mkdir(join(root, "memory"), { recursive: true });
  const collections: Collection[] = [
    {
      name: "memory",
      path: join(root, "memory"),
      pattern: "**/*.md",
      include: [],
      exclude: [],
      memoryManaged: true,
    },
  ];
  config = { ...createDefaultConfig(), collections };
  store = new SqliteAdapter();
  expect(
    (await store.open(join(root, "index-default.sqlite"), config.ftsTokenizer))
      .ok
  ).toBe(true);
  expect((await store.syncCollections(collections)).ok).toBe(true);
  service = new MemoryService({
    store,
    config,
    collections,
    lockPath: join(root, ".lock"),
    lockWaitMs: 5_000,
    embedPort: null,
  });
  const remember = (input: Record<string, unknown>) =>
    service.remember({
      ...IDENTITY,
      collection: "memory",
      scopes: SCOPES,
      ...input,
    } as Parameters<MemoryService["remember"]>[0]);
  const added = await remember({
    text: "The launch review happens on Fridays.",
    decision: "add",
  });
  if (added.outcome !== "added") throw new Error(added.outcome);
  original = added.record.uri;
  capsuleBefore = await buildContextCapsule(
    {
      goal: "launch review",
      collections: ["memory"],
      budgetTokens: 12_000,
      graph: false,
      noRerank: true,
      depthPolicy: "fast",
    },
    deps()
  );
  let predecessor = original;
  for (const text of [
    "The launch review moved to Thursdays.",
    "The launch review now happens on Wednesdays.",
  ]) {
    const recall = await service.recall({
      ...IDENTITY,
      query: "launch review",
      collection: "memory",
      scopes: SCOPES,
    });
    const fact = recall.facts.find((item) => item.uri === predecessor)!;
    const result = await remember({
      text,
      decision: "supersede",
      predecessorUri: fact.uri,
      predecessorHash: fact.contentHash,
    });
    if (result.outcome !== "superseded") throw new Error(result.outcome);
    predecessor = result.record.uri;
  }
  latest = predecessor;
});

afterAll(async () => {
  await store.close();
  await safeRm(root);
});

test("search marks the superseded fact with its current successor", async () => {
  const result = await searchBm25(store, "launch review", {
    collection: "memory",
    limit: 10,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const old = result.value.results.find((item) => item.uri === original);
  expect(old?.supersededBy).toBe(latest);
  const current = result.value.results.find((item) => item.uri === latest);
  expect(current?.supersededBy).toBeUndefined();
});

test("get names the successor; the current fact carries no mark", async () => {
  expect((await getDocumentByRef(store, config, original)).supersededBy).toBe(
    latest
  );
  expect(
    (await getDocumentByRef(store, config, latest)).supersededBy
  ).toBeUndefined();
});

test("the answer prompt marks the superseded source and says not to present it as current", async () => {
  const result = await searchBm25(store, "launch review", {
    collection: "memory",
    limit: 10,
  });
  if (!result.ok) throw new Error(result.error.message);
  let prompt = "";
  const answer = await generateGroundedAnswer(
    {
      genPort: {
        modelUri: "mock://gen",
        generate: async (value: string) => {
          prompt = value;
          return { ok: true as const, value: "Wednesdays [1]." };
        },
        dispose: async () => undefined,
      },
      store,
    },
    "When is the launch review?",
    result.value.results,
    256
  );
  expect(prompt).toContain(`superseded-by="${latest}"`);
  expect(prompt).toContain("never present it as current");
  expect(
    answer?.citations.find((citation) => citation.uri === original)
      ?.supersededBy
  ).toBe(latest);
});

test("a Capsule marks superseded evidence and an older Capsule citing it is stale", async () => {
  const capsule = await buildContextCapsule(
    {
      goal: "launch review",
      collections: ["memory"],
      budgetTokens: 12_000,
      graph: false,
      noRerank: true,
      depthPolicy: "fast",
    },
    deps()
  );
  expect(
    capsule.evidence.find((item) => item.uri === original)?.supersededBy
  ).toBe(latest);
  const receipt = await verifyContextCapsuleRuntime(capsuleBefore, deps());
  const old = receipt.evidence.find((item) => item.uri === original);
  expect(old).toMatchObject({
    contentStatus: "stale",
    contentCode: "superseded",
  });
});

test("lookups accept named-index URIs and output decorates the successor", async () => {
  const decorated = decorateUriForIndex(original, "work");
  const successors = await store.getSupersedingUris([decorated]);
  expect(successors.ok && successors.value.get(decorated)).toBe(latest);
  expect(
    decorateResultUris({ uri: original, supersededBy: latest }, "work")
  ).toEqual({
    uri: decorated,
    supersededBy: decorateUriForIndex(latest, "work"),
  });
});

test("text output names the successor", async () => {
  const result = await searchBm25(store, "launch review", {
    collection: "memory",
    limit: 10,
  });
  if (!result.ok) throw new Error(result.error.message);
  for (const format of ["terminal", "md", "xml"] as const) {
    expect(formatSearchResults(result.value, { format })).toContain(latest);
  }
});

test("ask sources name the successor in markdown and terminal output", async () => {
  const result = await searchBm25(store, "launch review", {
    collection: "memory",
    limit: 10,
  });
  if (!result.ok) throw new Error(result.error.message);
  const data = {
    query: "When is the launch review?",
    mode: "bm25_only",
    queryLanguage: "en",
    results: result.value.results,
    meta: { expanded: false, reranked: false, vectorsUsed: false },
  } as unknown as AskResult;
  for (const md of [true, false]) {
    expect(
      formatAsk({ success: true, data }, { md, showSources: true })
    ).toContain(`Superseded by: ${md ? "`" : ""}${latest}`);
  }
});

test("verification fails closed when the supersession lookup fails", async () => {
  const failing = new Proxy(store, {
    get: (target, key, receiver) =>
      key === "getSupersedingUris"
        ? async () => err("QUERY_FAILED", "lookup failed")
        : Reflect.get(target, key, receiver),
  });
  await expect(
    verifyContextCapsuleRuntime(capsuleBefore, { ...deps(), store: failing })
  ).rejects.toMatchObject({
    code: "document_load_failed",
    message: expect.stringContaining("supersession"),
  });
});
