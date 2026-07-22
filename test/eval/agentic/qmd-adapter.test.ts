import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises: temporary test directory lifecycle has no Bun equivalent.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
// node:os: temporary directory discovery has no Bun equivalent.
import { tmpdir } from "node:os";
// node:path: path construction has no Bun equivalent.
import { join } from "node:path";

import type {
  QmdMcpCallResult,
  QmdMcpConnection,
  QmdMcpTool,
} from "../../../evals/agentic/lifecycle/qmd-mcp";
import type { QmdNativeServices } from "../../../evals/agentic/lifecycle/qmd-native";
import type {
  QmdCommandRunner,
  QmdPreflightResult,
} from "../../../evals/agentic/qmd-preflight";
import type { AgentTask, CorpusSnapshot } from "../../../evals/agentic/types";

import {
  AgenticHarnessError,
  type AdapterPreparation,
} from "../../../evals/agentic/adapter";
import { createQmdAdapterFactory } from "../../../evals/agentic/adapters/qmd";
import {
  canonicalFingerprint,
  sha256Bytes,
} from "../../../evals/agentic/canonical";
import {
  loadQmdLock,
  QMD_MODEL_ROLES,
  type QmdLock,
  type QmdToolName,
} from "../../../evals/agentic/qmd-lock";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true }))
  );
});

const task: AgentTask = {
  schemaVersion: "1.0",
  taskId: "t0a1b2c3",
  category: "exact_identifier",
  brief: { goal: "Find alpha", instructions: [] },
  claims: [],
  allowedTools: ["search", "get", "multi_get"],
  budgets: { maxAgentCalls: 3, maxModelVisibleBytes: 10_000 },
  corpus: { collections: ["c001"] },
};

const snapshot: CorpusSnapshot = {
  fixtureVersion: "fixture",
  fingerprint: canonicalFingerprint({ fixture: "qmd-adapter" }),
  files: [
    {
      taskId: task.taskId,
      collection: "c001",
      relPath: "d001.md",
      sourcePath: "fixture/c001/d001.md",
      sourceHash: sha256Bytes("# Heading\nAlpha\nBeta\n"),
      content: "# Heading\nAlpha\nBeta\n",
    },
    {
      taskId: "t1b2c3d4",
      collection: "c002",
      relPath: "foreign.md",
      sourcePath: "fixture/c002/foreign.md",
      sourceHash: sha256Bytes("# Foreign\nSecret\n"),
      content: "# Foreign\nSecret\n",
    },
  ],
};

const tools: QmdMcpTool[] = [
  {
    name: "query",
    title: "Query",
    description: "Query fixture",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "get",
    title: "Get",
    description: "Get fixture",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: { file: { type: "string" } } },
  },
  {
    name: "multi_get",
    title: "Multi Get",
    description: "Multi-get fixture",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" } },
    },
  },
  {
    name: "status",
    title: "Status",
    description: "Status fixture",
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {} },
  },
];

const normalizedContract = (tool: QmdMcpTool) => ({
  name: tool.name,
  description: tool.description ?? null,
  inputSchema: tool.inputSchema,
});

const lockForTools = async (): Promise<QmdLock> => {
  const lock = structuredClone(await loadQmdLock());
  const sorted = [...tools].sort((left, right) =>
    left.name.localeCompare(right.name, "en")
  );
  for (const tool of sorted) {
    const name = tool.name as QmdToolName;
    lock.tools[name].inputSchemaSha256 = canonicalFingerprint(tool.inputSchema);
    lock.tools[name].contractSha256 = canonicalFingerprint(
      normalizedContract(tool)
    );
  }
  lock.tools.inputSchemasSha256 = canonicalFingerprint(
    sorted.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }))
  );
  lock.tools.contractsSha256 = canonicalFingerprint(
    sorted.map(normalizedContract)
  );
  return lock;
};

class FakeConnection implements QmdMcpConnection {
  readonly calls: Array<{
    name: QmdToolName;
    arguments: Record<string, unknown>;
  }> = [];
  closed = false;

  constructor(
    private readonly toolList: readonly QmdMcpTool[],
    private readonly malformed = false,
    private readonly volatilePath = "",
    private readonly emptyQuery = false
  ) {}

  async listTools(): Promise<readonly QmdMcpTool[]> {
    return structuredClone(this.toolList);
  }

  async callTool(
    name: QmdToolName,
    arguments_: Record<string, unknown>
  ): Promise<QmdMcpCallResult> {
    this.calls.push({ name, arguments: structuredClone(arguments_) });
    if (name === "status") {
      return {
        content: [{ type: "text", text: "ready" }],
        structuredContent: {
          totalDocuments: 2,
          needsEmbedding: 0,
          hasVectorIndex: true,
          collections: [
            { name: "c001", documents: 1 },
            { name: "c002", documents: 1 },
          ],
        },
      };
    }
    if (this.malformed) {
      return { content: [{ type: "image" }] };
    }
    if (name === "query") {
      return {
        content: [
          { type: "text", text: `Found 1 result from ${this.volatilePath}` },
        ],
        structuredContent: {
          results: this.emptyQuery
            ? []
            : [
                {
                  file: "qmd://c001/d001.md",
                  line: 2,
                  snippet:
                    "2: @@ -2,2 @@ (1 before, 0 after)\n3: Alpha\n4: Beta",
                },
              ],
        },
      };
    }
    return {
      content: [
        {
          type: "resource",
          resource: {
            uri: "qmd://c001/d001.md",
            text: "2: Alpha\n3: Beta",
          },
        },
      ],
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const createHarness = async (
  input: {
    toolList?: readonly QmdMcpTool[];
    malformed?: boolean;
    commandFailure?: boolean;
    emptyQuery?: boolean;
  } = {}
) => {
  const root = await mkdtemp(join(tmpdir(), "qmd-adapter-test-"));
  tempPaths.push(root);
  const modelRoot = join(root, "source-models");
  await mkdir(modelRoot, { recursive: true });
  const lock = await lockForTools();
  const modelPaths = {} as QmdPreflightResult["modelPaths"];
  for (const role of QMD_MODEL_ROLES) {
    const content = `${role}-fixture-model`;
    lock.models[role].bytes = new TextEncoder().encode(content).byteLength;
    lock.models[role].sha256 = sha256Bytes(content);
    const path = join(modelRoot, lock.models[role].cacheFile);
    await Bun.write(path, content);
    modelPaths[role] = path;
  }
  const preflight: QmdPreflightResult = {
    lock,
    lockFingerprint: canonicalFingerprint(lock),
    repoPath: join(root, "repo"),
    entrypointPath: join(root, "repo/bin/qmd"),
    modelCachePath: modelRoot,
    modelPaths,
    repositoryFingerprint: canonicalFingerprint({ repo: "fixture" }),
  };
  const connections: FakeConnection[] = [];
  const environments: Record<string, string>[] = [];
  const commands: Array<{
    command: string;
    args: readonly string[];
    cwd: string;
    env?: Record<string, string>;
  }> = [];
  const commandRunner: QmdCommandRunner = async (command) => {
    commands.push({
      command: command.command,
      args: [...command.args],
      cwd: command.cwd,
      env: command.env ? { ...command.env } : undefined,
    });
    if (command.command === "/usr/bin/git") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (input.commandFailure) {
      return { exitCode: 127, stdout: "", stderr: "command unavailable" };
    }
    const qmdArgs = command.args.slice(1);
    if (qmdArgs[0] === "--version") {
      return {
        exitCode: 0,
        stdout: `qmd ${lock.package.version} (${lock.repository.commit.slice(0, 7)})\n`,
        stderr: "",
      };
    }
    if (qmdArgs[0] === "embed") {
      await mkdir(join(command.env?.INDEX_PATH ?? "", ".."), {
        recursive: true,
      });
      await Bun.write(command.env?.INDEX_PATH ?? "", "fixture qmd database");
    }
    return { exitCode: 0, stdout: "ok\n", stderr: "" };
  };
  const services: QmdNativeServices = {
    commandRunner,
    async preflight() {
      return preflight;
    },
    async connector(input_) {
      expect(input_.runtimePath).toBe(process.execPath);
      expect(input_.entrypointPath).toBe(preflight.entrypointPath);
      environments.push(structuredClone(input_.env));
      const connection = new FakeConnection(
        input.toolList ?? tools,
        input.malformed,
        input_.env.INDEX_PATH,
        input.emptyQuery
      );
      connections.push(connection);
      return connection;
    },
    async cleanup(path) {
      await rm(path, { force: true, recursive: true });
    },
  };
  return { services, connections, environments, commands, preflight };
};

const prepareOwner = async (services: QmdNativeServices) => {
  const factory = createQmdAdapterFactory({ services });
  const owner = factory();
  const preparation = await owner.prepare({
    snapshot,
    prepared: null,
    signal: new AbortController().signal,
  });
  return { factory, owner, preparation };
};

const attach = async (
  factory: () => ReturnType<ReturnType<typeof createQmdAdapterFactory>>,
  preparation: AdapterPreparation
) => {
  const adapter = factory();
  await adapter.prepare({
    snapshot,
    prepared: preparation,
    signal: new AbortController().signal,
  });
  await adapter.reset({
    task,
    lifecycle: "cold",
    readinessProbe: false,
    signal: new AbortController().signal,
  });
  return adapter;
};

describe("qmd adapter", () => {
  test("prepares an isolated native index and maps canonical calls through stdio MCP", async () => {
    const harness = await createHarness();
    const { factory, owner, preparation } = await prepareOwner(
      harness.services
    );
    const adapter = await attach(factory, preparation);
    const signal = new AbortController().signal;
    const search = await adapter.callTool(
      "search",
      { query: "alpha", collection: "c001", limit: 3 },
      signal
    );
    expect(search.backendInvocations).toBe(0);
    expect(search.diagnostics).toContain(
      "qmd internal backend invocation count unavailable"
    );
    expect(search.result.resultRole).toBe("candidates");
    expect(search.result.evidence[0]).toMatchObject({
      uri: "gno://c001/d001.md",
      startLine: 2,
      sourceHash: snapshot.files[0]?.sourceHash,
      text: "Alpha",
      sourceHashProvenance: "harness_observed",
      backendSourceHash: null,
      backendSpanHash: null,
    });
    expect(search.result.evidence[0]?.startLine).toBe(2);
    expect(search.result.content).not.toContain("gno-agentic-qmd-");
    expect(harness.environments[0]?.INDEX_PATH).not.toBe(
      harness.environments[1]?.INDEX_PATH
    );
    const get = await adapter.callTool(
      "get",
      { uri: "gno://c001/d001.md", fromLine: 2, lineCount: 2 },
      signal
    );
    expect(get.result.evidence.map(({ text }) => text)).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(harness.connections.at(-1)?.calls).toContainEqual({
      name: "get",
      arguments: {
        file: "qmd://c001/d001.md",
        fromLine: 2,
        maxLines: 2,
        lineNumbers: true,
      },
    });
    await adapter.dispose();
    await owner.dispose();
  });

  test("isolates config, cache, data, and model copies outside the checkout", async () => {
    const harness = await createHarness();
    const { owner, preparation } = await prepareOwner(harness.services);
    const env = harness.environments[0] as Record<string, string>;
    for (const key of [
      "QMD_CONFIG_DIR",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "INDEX_PATH",
    ]) {
      expect(env[key]?.startsWith(harness.preflight.repoPath)).toBe(false);
      expect(env[key]).toContain("gno-agentic-qmd-");
    }
    expect(env.HF_HUB_OFFLINE).toBe("1");
    expect(preparation.observations.qmdIndexFileSha256).toMatch(
      /^[a-f0-9]{64}$/
    );
    expect(
      harness.commands
        .filter(({ command }) => command !== "/usr/bin/git")
        .every(
          ({ command, args }) =>
            command === process.execPath &&
            args[0] === harness.preflight.entrypointPath
        )
    ).toBe(true);
    await owner.dispose();
  });

  test("uses one discarded full product query to warm all qmd models without restarting", async () => {
    const harness = await createHarness();
    const { factory, owner, preparation } = await prepareOwner(
      harness.services
    );
    const adapter = factory();
    await adapter.prepare({
      snapshot,
      prepared: preparation,
      signal: new AbortController().signal,
    });
    const first = await adapter.reset({
      task,
      lifecycle: "warm",
      readinessProbe: true,
      signal: new AbortController().signal,
    });
    const second = await adapter.reset({
      task,
      lifecycle: "warm",
      readinessProbe: false,
      signal: new AbortController().signal,
    });
    expect(first.diagnostics).toEqual([
      "discarded full qmd query readiness probe",
    ]);
    expect(second.startup.valueMs).toBeNull();
    expect(harness.connections).toHaveLength(2);
    expect(harness.connections[1]?.calls).toEqual([
      {
        name: "query",
        arguments: {
          query: task.brief.goal,
          collections: task.corpus.collections,
          intent: "gno agentic warm readiness probe",
          rerank: true,
        },
      },
    ]);
    await adapter.dispose();
    await owner.dispose();

    const emptyHarness = await createHarness({ emptyQuery: true });
    const emptyPrepared = await prepareOwner(emptyHarness.services);
    const emptyAdapter = emptyPrepared.factory();
    await emptyAdapter.prepare({
      snapshot,
      prepared: emptyPrepared.preparation,
      signal: new AbortController().signal,
    });
    expect(
      emptyAdapter.reset({
        task,
        lifecycle: "warm",
        readinessProbe: true,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("full warm readiness query failed");
    await emptyAdapter.dispose();
    await emptyPrepared.owner.dispose();
  });

  test("fails closed on dynamic tool drift, unsupported arguments, and malformed output", async () => {
    const drifted = tools.filter(({ name }) => name !== "status");
    const driftHarness = await createHarness({ toolList: drifted });
    expect(prepareOwner(driftHarness.services)).rejects.toThrow(
      "Pinned qmd tools differ"
    );

    const harness = await createHarness({ malformed: true });
    const { factory, owner, preparation } = await prepareOwner(
      harness.services
    );
    const adapter = await attach(factory, preparation);
    expect(
      adapter.callTool(
        "search",
        { query: "alpha", filters: { tag: "x" } },
        new AbortController().signal
      )
    ).rejects.toThrow("cannot faithfully map search.filters");
    expect(
      adapter.callTool(
        "get",
        { uri: "gno://c001/d001.md" },
        new AbortController().signal
      )
    ).rejects.toThrow("malformed resource");
    await adapter.dispose();
    await owner.dispose();
  });

  test("fails preparation as a harness error when the locked runtime command is unavailable", async () => {
    const harness = await createHarness({ commandFailure: true });
    try {
      await prepareOwner(harness.services);
      throw new Error("expected command failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AgenticHarnessError);
      expect((error as AgenticHarnessError).code).toBe("qmd_command_failed");
    }
  });
});
