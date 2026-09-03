/**
 * `openclaw gno-memory <search|get|status|sync>`: the plugin's own CLI
 * namespace. `openclaw memory` belongs to memory-core and is unavailable
 * once `plugins.slots.memory` selects this plugin.
 */

import type { GnoMemoryBackend } from "./backend";

import { GnoCliError } from "./gno-cli";
import { formatSearchText } from "./tools";

/** The subset of commander's Command the registrar touches. */
export interface CommandLike {
  command: (name: string) => CommandLike;
  description: (text: string) => CommandLike;
  argument: (name: string, description?: string) => CommandLike;
  option: (flags: string, description?: string) => CommandLike;
  action: (
    handler: (...args: unknown[]) => Promise<void> | void
  ) => CommandLike;
}

export interface CliIo {
  write: (text: string) => void;
  fail: (message: string) => never;
}

export interface CliContext {
  program: CommandLike;
  workspaceDir?: string;
}

export const CLI_COMMAND = {
  name: "gno-memory",
  description: "Search OpenClaw memory files through GNO",
  hasSubcommands: true,
} as const;

function positiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** `--min-score` must be a finite number in [0, 1]; anything else is a usage error, not a NaN sent to gno. */
function minScore(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const text =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number"
        ? String(value)
        : "";
  const parsed = text === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(
      `--min-score must be a number between 0 and 1 (got ${JSON.stringify(text)})`
    );
  }
  return parsed;
}

function describeError(error: unknown): string {
  if (error instanceof GnoCliError) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function registerGnoMemoryCli(
  ctx: CliContext,
  backend: GnoMemoryBackend,
  io: CliIo
): void {
  const root = ctx.program
    .command(CLI_COMMAND.name)
    .description(CLI_COMMAND.description);
  const run = async (
    task: () => Promise<unknown>,
    json: boolean
  ): Promise<void> => {
    try {
      const value = await task();
      io.write(
        json ? `${JSON.stringify(value, null, 2)}\n` : `${String(value)}\n`
      );
    } catch (error) {
      io.fail(`gno-memory: ${describeError(error)}`);
    }
  };

  root
    .command("search")
    .description(
      "Search memory files (syncs the GNO index first unless disabled)"
    )
    .argument("<query>", "search text")
    .option("--max-results <n>", "cap result count")
    .option("--min-score <n>", "minimum score")
    .option("--json", "print JSON")
    .action(async (query, opts) => {
      const options = (opts ?? {}) as Record<string, unknown>;
      await run(async () => {
        const outcome = await backend.search(String(query), {
          workspaceDir: ctx.workspaceDir,
          maxResults: positiveInt(options.maxResults),
          minScore: minScore(options.minScore),
        });
        return options.json ? outcome : formatSearchText(outcome);
      }, Boolean(options.json));
    });

  root
    .command("get")
    .description(
      "Read an exact excerpt by gno:// URI or workspace-relative path"
    )
    .argument("<ref>", "gno:// URI or path")
    .option("--from <line>", "start line")
    .option("--lines <n>", "line count")
    .option("--json", "print JSON")
    .action(async (ref, opts) => {
      const options = (opts ?? {}) as Record<string, unknown>;
      await run(async () => {
        const excerpt = await backend.get(String(ref), {
          workspaceDir: ctx.workspaceDir,
          from: positiveInt(options.from),
          lines: positiveInt(options.lines),
        });
        return options.json
          ? excerpt
          : `${excerpt.content}\nSource: ${excerpt.uri}`;
      }, Boolean(options.json));
    });

  root
    .command("status")
    .description(
      "Show GNO version, collection registration, and stale-index state"
    )
    .option("--json", "print JSON")
    .action(async (opts) => {
      const options = (opts ?? {}) as Record<string, unknown>;
      await run(async () => {
        const status = await backend.status(ctx.workspaceDir);
        if (options.json) return status;
        return [
          `gno ${status.gnoVersion}`,
          `collection ${status.collection} -> ${status.root} (${status.pattern}) ${status.registered ? "registered" : "NOT registered"}`,
          `last sync ${status.lastSyncAt ?? "never"}`,
          status.stale ? `STALE: ${status.stale.reason}` : "index fresh",
        ].join("\n");
      }, Boolean(options.json));
    });

  root
    .command("sync")
    .description("Register the collection if needed and sync the GNO index now")
    .option("--json", "print JSON")
    .action(async (opts) => {
      const options = (opts ?? {}) as Record<string, unknown>;
      await run(async () => {
        const registration = await backend.ensureCollection(ctx.workspaceDir);
        const ok = await backend.sync(ctx.workspaceDir);
        const stale = backend.staleState;
        if (options.json) return { ...registration, synced: ok, stale };
        return ok
          ? `synced ${backend.config.collection} at ${registration.root}`
          : `sync failed: ${stale?.reason ?? "unknown"}`;
      }, Boolean(options.json));
    });
}
