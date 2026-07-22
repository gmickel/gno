/** Packed-install MCP contract verification for the package smoke gate. */

// node:fs/promises: canonical path resolution has no Bun-native equivalent.
import { realpath } from "node:fs/promises";
// node:path: portable path containment and joining have no Bun-native equivalent.
import { isAbsolute, join, relative } from "node:path";

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface PackedMcpEntry {
  command: string;
  args: string[];
  env: {
    GNO_DATA_DIR: string;
    GNO_CACHE_DIR: string;
  };
}

type CommandRunner = (
  cmd: string[],
  cwd: string,
  env: Record<string, string>
) => CommandResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function verifyPackedMcpInstall(input: {
  gnoBin: string;
  installPrefix: string;
  cwd: string;
  env: Record<string, string>;
  runCommand: CommandRunner;
}): Promise<void> {
  input.runCommand(
    [
      input.gnoBin,
      "mcp",
      "install",
      "--target",
      "codex",
      "--scope",
      "project",
      "--json",
    ],
    input.cwd,
    input.env
  );

  const configPath = join(input.cwd, ".codex", "config.toml");
  const configText = await Bun.file(configPath).text();
  let config: unknown;
  try {
    config = Bun.TOML.parse(configText);
  } catch (error) {
    throw new Error(
      `Packed MCP install emitted invalid Codex TOML at ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const maybeServers = isRecord(config) ? config.mcp_servers : undefined;
  const maybeEntry = isRecord(maybeServers) ? maybeServers.gno : undefined;
  if (!isRecord(maybeEntry)) {
    throw new Error(`Packed MCP install missing gno entry: ${configPath}`);
  }

  const rawArgs = maybeEntry.args;
  const rawEnv = maybeEntry.env;
  const entry: PackedMcpEntry = {
    command: typeof maybeEntry.command === "string" ? maybeEntry.command : "",
    args: Array.isArray(rawArgs)
      ? rawArgs.filter((value): value is string => typeof value === "string")
      : [],
    env: {
      GNO_DATA_DIR:
        isRecord(rawEnv) && typeof rawEnv.GNO_DATA_DIR === "string"
          ? rawEnv.GNO_DATA_DIR
          : "",
      GNO_CACHE_DIR:
        isRecord(rawEnv) && typeof rawEnv.GNO_CACHE_DIR === "string"
          ? rawEnv.GNO_CACHE_DIR
          : "",
    },
  };
  const expectedArgs = [
    "run",
    entry.args[1] ?? "",
    "--index",
    "default",
    "--config",
    join(input.env.GNO_CONFIG_DIR ?? "", "index.yml"),
    "mcp",
  ];
  if (
    !entry.command ||
    !isAbsolute(entry.command) ||
    !Array.isArray(rawArgs) ||
    entry.args.length !== rawArgs.length ||
    entry.args.length !== expectedArgs.length ||
    !entry.args.every((argument, index) => argument === expectedArgs[index]) ||
    entry.env.GNO_DATA_DIR !== input.env.GNO_DATA_DIR ||
    entry.env.GNO_CACHE_DIR !== input.env.GNO_CACHE_DIR
  ) {
    throw new Error(
      `Packed MCP install emitted an unexpected entry:\n${JSON.stringify(maybeEntry, null, 2)}`
    );
  }

  const runtimeEntrypoint = entry.args[1] ?? "";
  const [canonicalPrefix, canonicalEntrypoint] = await Promise.all([
    realpath(input.installPrefix),
    realpath(runtimeEntrypoint),
  ]);
  const relativeEntrypoint = relative(canonicalPrefix, canonicalEntrypoint);
  const normalizedEntrypoint = canonicalEntrypoint.replaceAll("\\", "/");
  const pointsInsideInstall =
    relativeEntrypoint.length > 0 &&
    !relativeEntrypoint.startsWith("..") &&
    !isAbsolute(relativeEntrypoint);
  if (
    !pointsInsideInstall ||
    !normalizedEntrypoint.endsWith("/node_modules/@gmickel/gno/src/index.ts") ||
    !(await Bun.file(runtimeEntrypoint).exists())
  ) {
    throw new Error(
      `Packed MCP entrypoint does not resolve to the installed package: ${runtimeEntrypoint}`
    );
  }

  // Prove the emitted Bun + package entrypoint pair actually executes after
  // installation; this catches missing files and package-layout drift.
  input.runCommand(
    [entry.command, ...entry.args.slice(0, 2), "--version"],
    input.cwd,
    { ...input.env, ...entry.env }
  );
}
