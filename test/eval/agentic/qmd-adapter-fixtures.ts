import type { QmdMcpTool } from "../../../evals/agentic/lifecycle/qmd-mcp";
import type { AgentTask, CorpusSnapshot } from "../../../evals/agentic/types";

import {
  canonicalFingerprint,
  sha256Bytes,
} from "../../../evals/agentic/canonical";
import {
  loadQmdLock,
  type QmdLock,
  type QmdToolName,
} from "../../../evals/agentic/qmd-lock";

export const qmdAdapterTask: AgentTask = {
  schemaVersion: "1.0",
  taskId: "t0a1b2c3",
  category: "exact_identifier",
  brief: { goal: "Find alpha", instructions: [] },
  claims: [],
  allowedTools: ["search", "get", "multi_get"],
  budgets: { maxAgentCalls: 3, maxModelVisibleBytes: 10_000 },
  corpus: { collections: ["c001"] },
};

export const qmdAdapterSnapshot: CorpusSnapshot = {
  fixtureVersion: "fixture",
  fingerprint: canonicalFingerprint({ fixture: "qmd-adapter" }),
  files: [
    {
      taskId: qmdAdapterTask.taskId,
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

export const qmdAdapterTools: QmdMcpTool[] = [
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

export const qmdLockForTools = async (): Promise<QmdLock> => {
  const lock = structuredClone(await loadQmdLock());
  const sorted = [...qmdAdapterTools].sort((left, right) =>
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
