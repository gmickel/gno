import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, test, spyOn } from "bun:test";
// Bun has no directory-creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LlmAdapter } from "../../src/llm/nodeLlamaCpp/adapter";
import { resolveModelUri } from "../../src/llm/registry";
import { createMcpServerSurface } from "../../src/mcp/context";
import { appendRetrievalWarnings } from "../../src/mcp/retrieval-warnings";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { createVectorIndexPort } from "../../src/store/vector";
import { createLegacyParityToolContext } from "../fixtures/mcp/legacy-parity-context";
import { safeRm } from "../helpers/cleanup";

test("warning-free text is unchanged; every warning retains its code and message", () => {
  const text = 'No results found for "needle"';
  expect(appendRetrievalWarnings(text, undefined)).toBe(text);
  expect(appendRetrievalWarnings(text, [])).toBe(text);
  expect(
    appendRetrievalWarnings(text, [
      {
        code: "METADATA_COVERAGE_UNKNOWN",
        message: "Coverage could not be checked.",
      },
      { code: "OTHER", message: "Another warning." },
    ])
  ).toContain("Warning [OTHER]: Another warning.");
  expect(
    appendRetrievalWarnings(text, [
      {
        code: "METADATA_COVERAGE_UNKNOWN",
        message: "Coverage could not be checked.",
      },
    ])
  ).toContain("not proof of absence");
});

test("real MCP search/query/vector responses preserve coverage in text and JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "gno-mcp-coverage-"));
  const store = new SqliteAdapter();
  const context = createLegacyParityToolContext(false);
  const collection = {
    name: "notes",
    path: root,
    pattern: "*.md",
    include: [],
    exclude: [],
  };
  context.store = store;
  context.collections = [collection];
  context.config.collections = [collection];
  context.actualConfigPath = join(root, "config.yml");
  expect((await store.open(join(root, "index.sqlite"), "unicode61")).ok).toBe(
    true
  );
  expect((await store.syncCollections([collection])).ok).toBe(true);
  for (const [name, valid] of [
    ["approved", true],
    ["invalid", false],
  ] as const) {
    const hash = name === "approved" ? "a".repeat(64) : "b".repeat(64);
    expect(
      (
        await store.upsertDocument({
          collection: "notes",
          relPath: name + ".md",
          sourceHash: hash,
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceSize: 20,
          sourceMtime: "2026-09-23T00:00:00Z",
          mirrorHash: hash,
          ingestVersion: 7,
          ...(valid
            ? { typedMetadata: { approved: true } }
            : { metadataError: "invalid typed metadata" }),
        })
      ).ok
    ).toBe(true);
    expect((await store.upsertContent(hash, "needle evidence")).ok).toBe(true);
    expect(
      (
        await store.upsertChunks(hash, [
          { seq: 0, pos: 0, text: "needle evidence", startLine: 1, endLine: 1 },
        ])
      ).ok
    ).toBe(true);
    expect((await store.rebuildFtsForHash(hash)).ok).toBe(true);
  }
  const modelUri = resolveModelUri(context.config, "embed", undefined, "notes");
  const llm = new LlmAdapter(context.config);
  const embed = spyOn(llm, "createEmbeddingPort").mockResolvedValue({
    ok: true,
    value: {
      modelUri,
      dimensions: () => 2,
      init: async () => ({ ok: true, value: undefined }),
      dispose: async () => {},
      embed: async () => ({ ok: true, value: [1, 0] }),
      embedBatch: async (texts) => ({
        ok: true,
        value: texts.map(() => [1, 0]),
      }),
    },
  });
  context.getModelAdapter = () => llm;
  const vector = await createVectorIndexPort(store.getRawDb(), {
    model: modelUri,
    dimensions: 2,
  });
  if (!vector.ok) throw new Error(vector.error.message);
  expect(
    (
      await vector.value.upsertVectors([
        {
          mirrorHash: "a".repeat(64),
          seq: 0,
          model: modelUri,
          embedFingerprint: "test",
          embedding: new Float32Array([1, 0]),
        },
      ])
    ).ok
  ).toBe(true);
  const server = createMcpServerSurface(context, {
    name: "coverage",
    version: "1",
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "coverage-test", version: "1" });
  await client.connect(clientSide);
  try {
    for (const name of ["gno_search", "gno_query", "gno_vsearch"]) {
      for (const approved of [true, false]) {
        const result = await client.callTool({
          name,
          arguments: {
            query: "needle",
            collection: "notes",
            filter: { op: "eq", key: "approved", value: approved },
            ...(name === "gno_query" ? { fast: true } : {}),
          },
        });
        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as {
          results: unknown[];
          meta: { warnings: { code: string; message: string }[] };
        };
        expect(structured.results.length).toBe(approved ? 1 : 0);
        const text = JSON.stringify(result.content);
        const warning = structured.meta.warnings[0]!;
        expect(warning.code).toBe("METADATA_COVERAGE_INCOMPLETE");
        expect(text).toContain(warning.code);
        expect(text).toContain(warning.message);
        expect(text).toContain("not proof of absence");
        expect(text).toContain("same filter");
      }
    }
    // Unknown coverage must also survive the real MCP response wrapper.
    const coverage = spyOn(store, "getTypedMetadataCoverage").mockResolvedValue(
      { ok: false, error: { code: "QUERY_FAILED", message: "unavailable" } }
    );
    const unknown = await client.callTool({
      name: "gno_search",
      arguments: {
        query: "absent",
        filter: { op: "eq", key: "approved", value: true },
      },
    });
    expect(JSON.stringify(unknown.content)).toContain(
      "METADATA_COVERAGE_UNKNOWN"
    );
    coverage.mockRestore();
    store
      .getRawDb()
      .run(
        "UPDATE documents SET metadata_error = NULL, typed_metadata = '{}' WHERE rel_path = ?",
        ["invalid.md"]
      );
    for (const name of ["gno_search", "gno_query", "gno_vsearch"]) {
      const complete = await client.callTool({
        name,
        arguments: {
          query: "needle",
          collection: "notes",
          filter: { op: "eq", key: "approved", value: false },
          ...(name === "gno_query" ? { fast: true } : {}),
        },
      });
      expect(complete.isError).not.toBe(true);
      expect(complete.content).toEqual([
        { type: "text", text: 'No results found for "needle"' },
      ]);
      expect(complete.structuredContent).toMatchObject({ results: [] });
      expect(
        (complete.structuredContent as { meta: { warnings?: unknown } }).meta
          .warnings
      ).toBeUndefined();
    }
    const plain = await client.callTool({
      name: "gno_search",
      arguments: { query: "absent" },
    });
    expect(plain.content).toEqual([
      { type: "text", text: 'No results found for "absent"' },
    ]);
  } finally {
    await client.close();
    await server.close();
    embed.mockRestore();
    await store.close();
    await safeRm(root);
  }
});
