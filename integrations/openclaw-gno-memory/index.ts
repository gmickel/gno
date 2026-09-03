/**
 * OpenClaw memory plugin backed by GNO (kind: "memory", selected via
 * `plugins.slots.memory: "gno-memory"`). OpenClaw keeps writing its own
 * memory files; GNO indexes and retrieves them. This module never writes.
 *
 * Kept free of `openclaw/plugin-sdk` imports so `bun test` can load it; the
 * exported object is exactly what `definePluginEntry` would return.
 */

// node:fs writeSync: OpenClaw exits right after a CLI action resolves, and an
// async process.stdout.write to a pipe can be lost on that exit. Synchronous
// writes are the only reliable channel for machine-readable output here.
import { writeSync } from "node:fs";

import { GnoMemoryBackend } from "./src/backend";
import { CLI_COMMAND, type CliContext, registerGnoMemoryCli } from "./src/cli";
import { resolveConfig } from "./src/config";
import {
  MEMORY_SOURCES,
  createMemoryGetTool,
  createMemorySearchTool,
} from "./src/tools";

export const PLUGIN_ID = "gno-memory";

/** Mirrors `configSchema` in openclaw.plugin.json (the manifest copy is authoritative). */
export const CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    collection: { type: "string" },
    root: { type: "string" },
    paths: { type: "array", items: { type: "string" } },
    exclude: { type: "array", items: { type: "string" } },
    gnoPath: { type: "string" },
    gnoArgs: { type: "array", items: { type: "string" } },
    timeoutMs: { type: "integer", minimum: 1 },
    syncBeforeSearch: { type: "boolean" },
    mode: { type: "string", enum: ["keyword", "hybrid"] },
    maxResults: { type: "integer", minimum: 1 },
  },
} as const;

interface PluginLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface CliDescriptor {
  name: string;
  description: string;
  hasSubcommands: boolean;
  /** Tells OpenClaw to keep its own log lines off stdout for machine-readable runs. */
  machineOutput?: (params: { argv: readonly string[] }) => boolean;
}

/** Root CLI descriptor: `--json` runs are machine output. */
export const CLI_DESCRIPTOR: CliDescriptor = {
  ...CLI_COMMAND,
  machineOutput: ({ argv }) => argv.includes("--json"),
};

/** The slice of OpenClawPluginApi this plugin uses. */
export interface PluginApi {
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerMemoryCapability: (capability: {
    deterministicRecallToolName?: string;
    supportsPrivateTranscriptRecall?: boolean;
    promptBuilder?: (params: {
      availableTools: Set<string>;
      citationsMode?: string;
    }) => string[];
  }) => void;
  registerTool: (
    factory: (ctx: { workspaceDir?: string }) => unknown,
    opts?: { names?: string[] }
  ) => void;
  registerCli: (
    registrar: (ctx: CliContext) => void | Promise<void>,
    opts?: { descriptors: CliDescriptor[] }
  ) => void;
  registerService: (service: {
    id: string;
    start: (ctx: {
      workspaceDir?: string;
      logger: PluginLogger;
    }) => Promise<void>;
  }) => void;
}

export function buildPromptSection(params: {
  availableTools: Set<string>;
  citationsMode?: string;
}): string[] {
  const hasSearch = params.availableTools.has("memory_search");
  const hasGet = params.availableTools.has("memory_get");
  if (!hasSearch && !hasGet) return [];
  const recall = hasSearch
    ? `run memory_search over ${MEMORY_SOURCES}${hasGet ? "; then memory_get to pull only the needed lines" : ""}`
    : `run memory_get on the file in ${MEMORY_SOURCES} that holds it`;
  return [
    "## Memory Recall",
    `Before answering anything about prior work, decisions, dates, people, preferences, or todos: ${recall}. If the response has disabled=true or stale=true, tell the user. If low confidence after search, say you checked.`,
    params.citationsMode === "off"
      ? "Citations are disabled: do not mention paths or line numbers unless the user asks."
      : "Citations: include Source: <gno:// URI#line> from the hit when it helps the user verify.",
    "",
  ];
}

export function register(api: PluginApi): void {
  const config = resolveConfig(api.pluginConfig);
  const backend = new GnoMemoryBackend(config, api.logger);

  api.registerMemoryCapability({
    deterministicRecallToolName: "memory_search",
    supportsPrivateTranscriptRecall: false,
    promptBuilder: buildPromptSection,
  });
  api.registerTool((ctx) => createMemorySearchTool(backend, api.logger, ctx), {
    names: ["memory_search"],
  });
  api.registerTool((ctx) => createMemoryGetTool(backend, api.logger, ctx), {
    names: ["memory_get"],
  });
  api.registerCli(
    (ctx) => {
      registerGnoMemoryCli(ctx, backend, {
        write: (text) => {
          writeSync(process.stdout.fd, text);
        },
        fail: (message) => {
          writeSync(process.stderr.fd, `${message}\n`);
          process.exit(1);
        },
      });
    },
    { descriptors: [CLI_DESCRIPTOR] }
  );
  // Plugin init: register the workspace memory paths as a GNO collection and
  // bring the index up to date. Failures are logged; the stale flag rides on
  // every later search until a sync succeeds.
  api.registerService({
    id: `${PLUGIN_ID}-init`,
    async start(ctx) {
      try {
        await backend.ensureCollection(ctx.workspaceDir);
      } catch (error) {
        ctx.logger.error(
          `gno-memory: collection registration failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }
      await backend.sync(ctx.workspaceDir);
    },
  });
}

export default {
  id: PLUGIN_ID,
  name: "GNO Memory",
  description: "Memory search over OpenClaw memory files through GNO retrieval",
  kind: "memory",
  configSchema: CONFIG_SCHEMA,
  register,
};
