import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { ToolContext } from "../../src/mcp/context";
import type { HttpMcpTransportRuntime } from "../../src/mcp/http-transport";
import type { DocumentInput } from "../../src/store/types";

import { createMcpServerSurface } from "../../src/mcp/context";
import { HttpMcpTransport } from "../../src/mcp/http-transport";
import { SECTION_MCP_ANNOTATIONS } from "../../src/mcp/tools/sections";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const SECTION_FIXTURE_CONTENT = [
  "# Shared fixture",
  "",
  "## Setup",
  "",
  "Transport-neutral evidence.",
].join("\n");

describe("stdio and HTTP MCP parity", () => {
  let root: string;
  let store: SqliteAdapter;
  let context: ToolContext;
  let stdioServer: ReturnType<typeof createMcpServerSurface>;
  let stdioClient: Client;
  let httpClient: Client;
  let httpTransport: HttpMcpTransport;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-http-parity-"));
    store = new SqliteAdapter();
    expect((await store.open(join(root, "test.db"), "unicode61")).ok).toBe(
      true
    );
    const collections = [
      {
        name: "notes",
        path: root,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ];
    expect((await store.syncCollections(collections)).ok).toBe(true);
    const fixture: DocumentInput = {
      collection: "notes",
      relPath: "fixture.md",
      sourceHash: "http-parity-fixture",
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: SECTION_FIXTURE_CONTENT.length,
      sourceMtime: new Date(0).toISOString(),
      title: "Shared fixture",
      mirrorHash: "http-parity-fixture",
      ingestVersion: 3,
    };
    expect((await store.upsertDocument(fixture)).ok).toBe(true);
    expect(
      (await store.upsertContent(fixture.mirrorHash!, SECTION_FIXTURE_CONTENT))
        .ok
    ).toBe(true);

    const config: Config = {
      version: "1.0",
      ftsTokenizer: "unicode61" as const,
      collections,
      contexts: [],
    };
    context = {
      store,
      config,
      collections,
      actualConfigPath: join(root, "config.yml"),
      indexName: "parity",
      toolMutex: { acquire: async () => () => undefined },
      jobManager: {} as ToolContext["jobManager"],
      serverInstanceId: "parity",
      writeLockPath: join(root, ".lock"),
      enableWrite: false,
      isShuttingDown: () => false,
    };

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    stdioServer = createMcpServerSurface(context, {
      name: "parity",
      version: "1.0.0",
    });
    await stdioServer.connect(serverSide);
    stdioClient = new Client({ name: "stdio-parity", version: "1.0.0" });
    await stdioClient.connect(clientSide);

    const runtime: HttpMcpTransportRuntime = {
      mcpContext: context,
      isShuttingDown: false,
      admitRequest: () => ({
        id: crypto.randomUUID(),
        signal: new AbortController().signal,
        finish: () => undefined,
      }),
      openSession: () => () => undefined,
    };
    httpTransport = new HttpMcpTransport(runtime);
    const webTransport = new StreamableHTTPClientTransport(
      new URL("http://127.0.0.1:3210/mcp"),
      {
        fetch: (input, init) =>
          httpTransport.handleRequest(new Request(input, init)),
      }
    );
    httpClient = new Client({ name: "http-parity", version: "1.0.0" });
    await httpClient.connect(webTransport);
  });

  afterEach(async () => {
    await Promise.allSettled([
      stdioClient.close(),
      httpClient.close(),
      stdioServer.close(),
      httpTransport.close(),
    ]);
    await store.close();
    await safeRm(root);
  });

  test("publishes equivalent tools, resources, and fixture results", async () => {
    const [stdioTools, httpTools, stdioResources, httpResources] =
      await Promise.all([
        stdioClient.listTools(),
        httpClient.listTools(),
        stdioClient.listResources(),
        httpClient.listResources(),
      ]);
    expect(httpTools).toEqual(stdioTools);
    expect(httpResources).toEqual(stdioResources);

    const sectionTool = stdioTools.tools.find(
      (tool) => tool.name === "gno_section"
    );
    expect(sectionTool).toBeDefined();
    expect(sectionTool?.annotations).toEqual(SECTION_MCP_ANNOTATIONS);
    expect(sectionTool?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(sectionTool?.inputSchema.required).toEqual(
      expect.arrayContaining(["action", "ref"])
    );
    expect(sectionTool?.inputSchema.properties).toMatchObject({
      action: expect.anything(),
      ref: expect.anything(),
      anchor: expect.anything(),
      line: expect.anything(),
      target: expect.anything(),
    });
    expect(sectionTool?.outputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(sectionTool?.outputSchema?.required).toEqual(
      expect.arrayContaining(["schemaVersion", "action", "uri", "target"])
    );
    expect(sectionTool?.outputSchema?.properties).toMatchObject({
      schemaVersion: expect.anything(),
      action: expect.anything(),
      uri: expect.anything(),
      target: expect.anything(),
      status: expect.anything(),
      citation: expect.anything(),
      diagnostics: expect.anything(),
    });

    const [stdioStatus, httpStatus] = await Promise.all([
      stdioClient.callTool({ name: "gno_status", arguments: {} }),
      httpClient.callTool({ name: "gno_status", arguments: {} }),
    ]);
    expect(httpStatus).toEqual(stdioStatus);

    const [stdioTags, httpTags] = await Promise.all([
      stdioClient.readResource({ uri: "gno://notes/fixture.md" }),
      httpClient.readResource({ uri: "gno://notes/fixture.md" }),
    ]);
    expect(httpTags).toEqual(stdioTags);

    const createArgs = {
      action: "create",
      ref: "gno://notes/fixture.md",
      anchor: "setup",
    };
    const [stdioCreate, httpCreate] = await Promise.all([
      stdioClient.callTool({ name: "gno_section", arguments: createArgs }),
      httpClient.callTool({ name: "gno_section", arguments: createArgs }),
    ]);
    expect(stdioCreate.isError).not.toBe(true);
    expect(httpCreate).toEqual(stdioCreate);
    expect(stdioCreate.structuredContent).toMatchObject({
      schemaVersion: "1.0",
      action: "create",
      uri: "gno://notes/fixture.md",
    });
    const createdTarget = (
      stdioCreate.structuredContent as {
        target: Record<string, unknown>;
      }
    ).target;

    const resolveArgs = {
      action: "resolve",
      ref: "gno://notes/fixture.md",
      target: createdTarget,
    };
    const [stdioResolve, httpResolve] = await Promise.all([
      stdioClient.callTool({ name: "gno_section", arguments: resolveArgs }),
      httpClient.callTool({ name: "gno_section", arguments: resolveArgs }),
    ]);
    expect(stdioResolve.isError).not.toBe(true);
    expect(httpResolve).toEqual(stdioResolve);
    expect(stdioResolve.structuredContent).toMatchObject({
      schemaVersion: "1.0",
      action: "resolve",
      status: "exact",
      uri: "gno://notes/fixture.md",
      citation: {
        uri: "gno://notes/fixture.md",
        anchor: "setup",
      },
    });
    const citation = (
      stdioResolve.structuredContent as {
        citation: { lineStart: number; lineEnd: number };
      }
    ).citation;
    expect(citation.lineEnd).toBeGreaterThanOrEqual(citation.lineStart);
  });
});
