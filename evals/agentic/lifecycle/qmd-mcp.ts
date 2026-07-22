import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { AgenticHarnessError, AgenticProductError } from "../adapter";
import { canonicalFingerprint } from "../canonical";
import { QMD_TOOL_NAMES, type QmdLock, type QmdToolName } from "../qmd-lock";

export interface QmdMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface QmdMcpCallResult {
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface QmdMcpConnection {
  listTools(signal?: AbortSignal): Promise<readonly QmdMcpTool[]>;
  callTool(
    name: QmdToolName,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<QmdMcpCallResult>;
  close(): Promise<void>;
}

export interface QmdMcpConnectInput {
  runtimePath: string;
  entrypointPath: string;
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
}

export type QmdMcpConnector = (
  input: QmdMcpConnectInput
) => Promise<QmdMcpConnection>;

class RealQmdMcpConnection implements QmdMcpConnection {
  constructor(private readonly client: Client) {}

  async listTools(signal?: AbortSignal): Promise<readonly QmdMcpTool[]> {
    const result = await this.client.listTools(undefined, { signal });
    return result.tools as QmdMcpTool[];
  }

  async callTool(
    name: QmdToolName,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<QmdMcpCallResult> {
    try {
      return (await this.client.callTool(
        { name, arguments: arguments_ },
        undefined,
        { signal }
      )) as QmdMcpCallResult;
    } catch (cause) {
      throw new AgenticProductError(
        "qmd_mcp_call_failed",
        `qmd MCP tool ${name} failed`,
        { cause }
      );
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export const connectQmdMcp: QmdMcpConnector = async (input) => {
  const client = new Client({ name: "gno-agentic-qmd", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: input.runtimePath,
    args: [input.entrypointPath, "mcp"],
    cwd: input.cwd,
    env: input.env,
    stderr: "ignore",
  });
  try {
    await client.connect(transport, { signal: input.signal });
    return new RealQmdMcpConnection(client);
  } catch (cause) {
    await client.close().catch(() => undefined);
    throw new AgenticHarnessError(
      "qmd_mcp_unavailable",
      "Pinned qmd MCP entrypoint could not start under the isolated runtime",
      { cause }
    );
  }
};

const normalizedContract = (tool: QmdMcpTool): Record<string, unknown> => ({
  name: tool.name,
  description: tool.description ?? null,
  inputSchema: tool.inputSchema,
});

export const validateQmdMcpContract = async (
  connection: QmdMcpConnection,
  lock: QmdLock,
  signal?: AbortSignal
): Promise<void> => {
  const tools = [...(await connection.listTools(signal))].sort((left, right) =>
    left.name.localeCompare(right.name, "en")
  );
  const expectedNames = [...QMD_TOOL_NAMES].sort();
  const actualNames = tools.map(({ name }) => name);
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new AgenticHarnessError(
      "qmd_tool_contract_mismatch",
      `Pinned qmd tools differ: expected ${expectedNames.join(",")}, got ${actualNames.join(",")}`
    );
  }

  for (const tool of tools) {
    const name = tool.name as QmdToolName;
    if (
      canonicalFingerprint(tool.inputSchema) !==
      lock.tools[name].inputSchemaSha256
    ) {
      throw new AgenticHarnessError(
        "qmd_tool_schema_mismatch",
        `Pinned qmd ${name} input schema hash differs`
      );
    }
    if (
      canonicalFingerprint(normalizedContract(tool)) !==
      lock.tools[name].contractSha256
    ) {
      throw new AgenticHarnessError(
        "qmd_tool_contract_mismatch",
        `Pinned qmd ${name} full contract hash differs`
      );
    }
  }

  const schemas = tools.map((tool) => ({
    name: tool.name,
    inputSchema: tool.inputSchema,
  }));
  const contracts = tools.map(normalizedContract);
  if (canonicalFingerprint(schemas) !== lock.tools.inputSchemasSha256) {
    throw new AgenticHarnessError(
      "qmd_tool_schema_mismatch",
      "Pinned qmd aggregate input-schema hash differs"
    );
  }
  if (canonicalFingerprint(contracts) !== lock.tools.contractsSha256) {
    throw new AgenticHarnessError(
      "qmd_tool_contract_mismatch",
      "Pinned qmd aggregate full-contract hash differs"
    );
  }
};
