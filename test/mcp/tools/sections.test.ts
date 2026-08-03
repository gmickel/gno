/**
 * MCP gno_section tool tests — create/resolve, annotations, no-write, gno_get.
 */

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../../../src/mcp/server";
import type { DocumentInput } from "../../../src/store/types";

import resolveResultSchema from "../../../spec/output-schemas/section-target-resolve-result.schema.json";
import targetSchema from "../../../spec/output-schemas/section-target.schema.json";
import sectionSchema from "../../../spec/output-schemas/section.schema.json";
import { SECTION_TARGET_BOUNDS } from "../../../src/core/sections";
import { handleGet } from "../../../src/mcp/tools/get";
import {
  MCP_TOOL_DESCRIPTIONS,
  MCP_WRITE_TOOL_NAMES,
  registerTools,
} from "../../../src/mcp/tools/index";
import {
  handleSection,
  SECTION_MCP_ANNOTATIONS,
  sectionInputSchema,
  sectionOutputSchema,
  type SectionMcpResult,
} from "../../../src/mcp/tools/sections";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { safeRm } from "../../helpers/cleanup";
import {
  SECTION_FIXTURE_CONTENT,
  SECTION_SEMANTIC_CASES,
  wrongDocumentTarget,
} from "../../helpers/section-target-fixtures";

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(targetSchema);
ajv.addSchema(resolveResultSchema);
const validateSection = ajv.compile(sectionSchema);

const SECTION_READ_METHODS = [
  "getDocumentByDocid",
  "getDocumentByUri",
  "getDocument",
  "getContent",
] as const;

type SectionReadMethod = (typeof SECTION_READ_METHODS)[number];

function createReadOnlyStoreFacade(store: SqliteAdapter): {
  facade: SqliteAdapter;
  readAccesses: SectionReadMethod[];
  blockedAccesses: string[];
} {
  const readAccesses: SectionReadMethod[] = [];
  const blockedAccesses: string[] = [];
  const allowed = new Set<string>(SECTION_READ_METHODS);

  const facade = new Proxy(store, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") {
        return Reflect.get(target, prop, receiver);
      }
      const name = String(prop);
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }
      if (allowed.has(name)) {
        return (...args: unknown[]) => {
          readAccesses.push(name as SectionReadMethod);
          return (value as (...inner: unknown[]) => unknown).apply(
            target,
            args
          );
        };
      }
      return (..._args: unknown[]) => {
        blockedAccesses.push(name);
        throw new Error(
          `Read-only store facade blocked non-read method: ${name}`
        );
      };
    },
  }) as SqliteAdapter;

  return { facade, readAccesses, blockedAccesses };
}

function oversizedSerializedTarget() {
  return {
    schemaVersion: "1" as const,
    document: {
      uri: `gno://${"u".repeat(SECTION_TARGET_BOUNDS.uriMaxChars - 6)}`,
    },
    anchor: "a".repeat(SECTION_TARGET_BOUNDS.anchorMaxChars),
    headingPath: Array.from(
      { length: SECTION_TARGET_BOUNDS.headingPathMaxItems },
      (_, index) =>
        `${index}${"H".repeat(SECTION_TARGET_BOUNDS.headingPathItemMaxChars - 1)}`
    ),
    occurrence: 1,
    quote: {
      exact: "x".repeat(SECTION_TARGET_BOUNDS.exactMaxChars),
      prefix: "y".repeat(SECTION_TARGET_BOUNDS.prefixMaxChars),
      suffix: "z".repeat(SECTION_TARGET_BOUNDS.suffixMaxChars),
    },
    sourceFingerprint: "a".repeat(64),
    hints: { line: 3, startOffset: 0, endOffset: 1 },
  };
}

describe("gno_section MCP", () => {
  let tmpDir: string;
  let store: SqliteAdapter;
  let contentByHash: Map<string, string>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-mcp-section-"));
    store = new SqliteAdapter();
    const opened = await store.open(join(tmpDir, "test.db"), "porter");
    expect(opened.ok).toBe(true);
    const sync = await store.syncCollections([
      {
        name: "notes",
        path: tmpDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ]);
    expect(sync.ok).toBe(true);

    contentByHash = new Map();
    const originalGetContent = store.getContent.bind(store);
    store.getContent = async (hash: string) => {
      const local = contentByHash.get(hash);
      if (local !== undefined) {
        return { ok: true as const, value: local };
      }
      return originalGetContent(hash);
    };
  });

  afterEach(async () => {
    await store.close();
    await safeRm(tmpDir);
  });

  function toolContext(
    enableWrite = false,
    storeOverride: SqliteAdapter = store
  ): ToolContext {
    return {
      indexName: "default",
      store: storeOverride,
      config: {
        version: "1.0",
        ftsTokenizer: "porter",
        collections: [],
        contexts: [],
      },
      collections: [
        {
          name: "notes",
          path: tmpDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
      actualConfigPath: join(tmpDir, "config.yml"),
      toolMutex: {
        acquire: async () => () => {},
      } as ToolContext["toolMutex"],
      jobManager: {} as ToolContext["jobManager"],
      serverInstanceId: "test-server",
      writeLockPath: join(tmpDir, ".lock"),
      enableWrite,
      isShuttingDown: () => false,
    };
  }

  async function upsertDoc(
    content: string,
    relPath = "pilot.md"
  ): Promise<{ docid: string; uri: string }> {
    const hash = `h-${Bun.hash(content).toString(16)}`;
    contentByHash.set(hash, content);
    const doc: DocumentInput = {
      collection: "notes",
      relPath,
      sourceHash: hash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: content.length,
      sourceMtime: new Date().toISOString(),
      title: "Pilot",
      mirrorHash: hash,
      ingestVersion: 2,
    };
    const result = await store.upsertDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("upsert failed");
    const loaded = await store.getDocumentByDocid(result.value.docid);
    expect(loaded.ok && loaded.value).toBeTruthy();
    if (!loaded.ok || !loaded.value) throw new Error("load failed");
    return { docid: loaded.value.docid, uri: loaded.value.uri };
  }

  test("registers as read-only when enableWrite=false and is not a write tool", () => {
    const names: string[] = [];
    const annotationsByName = new Map<string, unknown>();
    const fakeServer = {
      tool: (name: string) => {
        names.push(name);
      },
      registerTool: (
        name: string,
        config: { annotations?: unknown; outputSchema?: unknown }
      ) => {
        names.push(name);
        annotationsByName.set(name, config.annotations);
        if (name === "gno_section") {
          expect(config.outputSchema).toBeDefined();
        }
      },
    };

    registerTools(fakeServer as never, toolContext(false));

    expect(names).toContain("gno_section");
    expect(names).toContain("gno_get");
    expect(MCP_WRITE_TOOL_NAMES.has("gno_section")).toBe(false);
    expect(annotationsByName.get("gno_section")).toEqual(
      SECTION_MCP_ANNOTATIONS
    );
    expect(MCP_TOOL_DESCRIPTIONS.section).toContain("Read-only");
  });

  test("input schema rejects malformed, unknown, and XOR violations", () => {
    expect(sectionInputSchema.safeParse({}).success).toBe(false);
    expect(
      sectionInputSchema.safeParse({ action: "create", ref: "notes/a.md" })
        .success
    ).toBe(false);
    expect(
      sectionInputSchema.safeParse({
        action: "create",
        ref: "notes/a.md",
        anchor: "setup",
        line: 3,
      }).success
    ).toBe(false);
    expect(
      sectionInputSchema.safeParse({
        action: "resolve",
        ref: "notes/a.md",
      }).success
    ).toBe(false);
    expect(
      sectionInputSchema.safeParse({
        action: "unknown",
        ref: "notes/a.md",
        anchor: "setup",
      }).success
    ).toBe(false);
    expect(
      sectionInputSchema.safeParse({
        action: "create",
        ref: "notes/a.md",
        anchor: "setup",
        extra: true,
      }).success
    ).toBe(false);
    expect(
      sectionInputSchema.safeParse({
        action: "create",
        ref: "notes/a.md",
        anchor: "x".repeat(513),
      }).success
    ).toBe(false);
    expect(
      sectionInputSchema.safeParse({
        action: "create",
        ref: "notes/a.md",
        anchor: "setup",
      }).success
    ).toBe(true);
    expect(
      sectionInputSchema.safeParse({
        action: "create",
        ref: "notes/a.md",
        line: 3,
      }).success
    ).toBe(true);
  });

  test("input schema rejects inverted hints and oversized serialized targets", () => {
    const fingerprint = "b".repeat(64);
    const legalFields = {
      schemaVersion: "1" as const,
      document: { uri: "gno://notes/a.md" },
      anchor: "setup",
      headingPath: ["Guide", "Setup"],
      occurrence: 1,
      quote: { exact: "Install", prefix: "", suffix: "" },
      sourceFingerprint: fingerprint,
    };

    const inverted = sectionInputSchema.safeParse({
      action: "resolve",
      ref: "gno://notes/a.md",
      target: {
        ...legalFields,
        hints: { line: 3, startOffset: 40, endOffset: 10 },
      },
    });
    expect(inverted.success).toBe(false);

    const oversized = oversizedSerializedTarget();
    expect(oversized.document.uri.length).toBe(
      SECTION_TARGET_BOUNDS.uriMaxChars
    );
    const oversizeParse = sectionInputSchema.safeParse({
      action: "resolve",
      ref: "gno://notes/a.md",
      target: oversized,
    });
    expect(oversizeParse.success).toBe(false);
  });

  for (const fixture of SECTION_SEMANTIC_CASES) {
    test(`create+resolve ${fixture.id}`, async () => {
      const captureDoc = await upsertDoc(fixture.captureContent, "capture.md");
      const createArgs =
        "anchor" in fixture.selector
          ? {
              action: "create" as const,
              ref: captureDoc.uri,
              anchor: fixture.selector.anchor,
            }
          : {
              action: "create" as const,
              ref: captureDoc.uri,
              line: fixture.selector.line,
            };

      const created = await handleSection(createArgs, toolContext(false));
      expect(created.isError).toBeFalsy();
      const createData = created.structuredContent as SectionMcpResult;
      expect(validateSection(createData)).toBe(true);
      expect(sectionOutputSchema.safeParse(createData).success).toBe(true);
      expect(createData).toMatchObject({
        schemaVersion: "1.0",
        action: "create",
        uri: captureDoc.uri,
      });
      expect(created.content[0]?.text).toContain('"action": "create"');

      const resolveDoc = await upsertDoc(fixture.resolveContent, "resolve.md");
      if (createData.action !== "create") throw new Error("expected create");
      const targetForResolve = {
        ...createData.target,
        document: { uri: resolveDoc.uri },
      };

      const resolved = await handleSection(
        {
          action: "resolve",
          ref: resolveDoc.uri,
          target: targetForResolve,
        },
        toolContext(false)
      );
      expect(resolved.isError).toBeFalsy();
      const resolveData = resolved.structuredContent as SectionMcpResult;
      expect(validateSection(resolveData)).toBe(true);
      expect(sectionOutputSchema.safeParse(resolveData).success).toBe(true);
      expect(resolveData).toMatchObject({
        schemaVersion: "1.0",
        action: "resolve",
        status: fixture.expectedStatus,
        uri: resolveDoc.uri,
      });

      if (fixture.navigable) {
        expect(resolveData.citation).toBeDefined();
        expect(resolveData.citation).toMatchObject({
          uri: resolveDoc.uri,
        });
        expect(resolved.content[0]?.text).toContain("gno_get");
        expect(resolved.content[0]?.text).toContain("fromLine");
        expect(resolved.content[0]?.text).not.toContain(
          "not safe to navigate or cite"
        );
      } else {
        expect(resolveData.citation).toBeUndefined();
        expect(resolved.content[0]?.text).toContain(
          "not safe to navigate or cite"
        );
      }
    });
  }

  test("wrong-document target resolves as missing without citation", async () => {
    const doc = await upsertDoc(SECTION_FIXTURE_CONTENT);
    const wrong = await wrongDocumentTarget(SECTION_FIXTURE_CONTENT);
    const result = await handleSection(
      { action: "resolve", ref: doc.uri, target: wrong },
      toolContext(false)
    );
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as SectionMcpResult;
    expect(validateSection(data)).toBe(true);
    expect(data).toMatchObject({
      action: "resolve",
      status: "missing",
    });
    expect(data.citation).toBeUndefined();
    expect(result.content[0]?.text).toContain("not safe to navigate or cite");
  });

  test("create with unknown section returns NOT_FOUND", async () => {
    const doc = await upsertDoc(SECTION_FIXTURE_CONTENT);
    const result = await handleSection(
      { action: "create", ref: doc.uri, anchor: "does-not-exist" },
      toolContext(false)
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: "NOT_FOUND",
    });
  });

  test("create/resolve with enableWrite=false never touch non-read store methods", async () => {
    const doc = await upsertDoc(SECTION_FIXTURE_CONTENT);
    const { facade, readAccesses, blockedAccesses } =
      createReadOnlyStoreFacade(store);
    const ctx = toolContext(false, facade);

    const created = await handleSection(
      { action: "create", ref: doc.uri, anchor: "setup" },
      ctx
    );
    expect(created.isError).toBeFalsy();
    const createData = created.structuredContent as SectionMcpResult;
    expect(createData.action).toBe("create");

    const resolved = await handleSection(
      {
        action: "resolve",
        ref: doc.uri,
        target: createData.target,
      },
      ctx
    );
    expect(resolved.isError).toBeFalsy();
    expect(resolved.structuredContent).toMatchObject({
      action: "resolve",
      status: "exact",
    });

    expect(blockedAccesses).toEqual([]);
    expect(readAccesses.length).toBeGreaterThan(0);
    expect(new Set(readAccesses).size).toBeGreaterThan(0);
    for (const name of readAccesses) {
      expect(SECTION_READ_METHODS).toContain(name);
    }

    // Prove the facade still fails closed if a mutation method is touched.
    expect(() => {
      void facade.upsertDocument({} as never);
    }).toThrow(/blocked non-read method: upsertDocument/);
    expect(blockedAccesses).toContain("upsertDocument");
  });

  test("resolve rejects inverted hints before core resolution", async () => {
    const doc = await upsertDoc(SECTION_FIXTURE_CONTENT);
    const { facade, readAccesses, blockedAccesses } =
      createReadOnlyStoreFacade(store);
    const created = await handleSection(
      { action: "create", ref: doc.uri, anchor: "setup" },
      toolContext(false)
    );
    expect(created.isError).toBeFalsy();
    const createData = created.structuredContent as SectionMcpResult;

    readAccesses.length = 0;
    const result = await handleSection(
      {
        action: "resolve",
        ref: doc.uri,
        target: {
          ...createData.target,
          hints: {
            ...createData.target.hints,
            startOffset: 40,
            endOffset: 10,
          },
        },
      },
      toolContext(false, facade)
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: "VALIDATION",
    });
    expect(String(result.structuredContent?.message)).toContain(
      "hints.endOffset"
    );
    expect(readAccesses).toEqual([]);
    expect(blockedAccesses).toEqual([]);
  });

  test("resolve rejects oversized serialized target before core resolution", async () => {
    const doc = await upsertDoc(SECTION_FIXTURE_CONTENT);
    const { facade, readAccesses } = createReadOnlyStoreFacade(store);
    const oversized = oversizedSerializedTarget();

    const result = await handleSection(
      {
        action: "resolve",
        ref: doc.uri,
        target: oversized,
      },
      toolContext(false, facade)
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: "VALIDATION",
      message: "Section target exceeds size bounds",
    });
    expect(readAccesses).toEqual([]);
  });

  test("gno_get line-range behavior remains unchanged", async () => {
    const doc = await upsertDoc(SECTION_FIXTURE_CONTENT);
    const result = await handleGet(
      { ref: doc.uri, fromLine: 3, lineCount: 2, lineNumbers: true },
      toolContext(false)
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      uri: doc.uri,
      returnedLines: { start: 3, end: 4 },
    });
    expect(result.structuredContent?.content).toBe("3: ## Setup\n4: ");
  });
});
