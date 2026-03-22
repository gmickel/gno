import type { McpScope, McpTarget } from "../cli/commands/mcp/paths";
import type { SkillScope, SkillTarget } from "../cli/commands/skill/paths";

import { installMcpToTarget } from "../cli/commands/mcp/install";
import {
  buildMcpServerEntry,
  getTargetDisplayName,
} from "../cli/commands/mcp/paths";
import { checkMcpTargetStatus } from "../cli/commands/mcp/status";
import { installSkillToTarget } from "../cli/commands/skill/install";
import { resolveSkillPaths } from "../cli/commands/skill/paths";

export interface ConnectorStatus {
  id: string;
  appName: string;
  installKind: "skill" | "mcp";
  target: string;
  scope: "user" | "project";
  installed: boolean;
  path: string;
  summary: string;
  nextAction: string;
  mode: {
    label: string;
    detail: string;
  };
  error?: string;
}

interface SkillConnectorDefinition {
  id: string;
  appName: string;
  installKind: "skill";
  target: SkillTarget;
  scope: SkillScope;
  mode: ConnectorStatus["mode"];
}

interface McpConnectorDefinition {
  id: string;
  appName: string;
  installKind: "mcp";
  target: McpTarget;
  scope: McpScope;
  mode: ConnectorStatus["mode"];
}

type ConnectorDefinition = SkillConnectorDefinition | McpConnectorDefinition;

const CONNECTOR_DEFINITIONS: ConnectorDefinition[] = [
  {
    id: "claude-code-skill",
    appName: "Claude Code",
    installKind: "skill",
    target: "claude",
    scope: "user",
    mode: {
      label: "Read/search via skill",
      detail:
        "Recommended default. The agent can search and retrieve with GNO without editing client JSON.",
    },
  },
  {
    id: "claude-desktop-mcp",
    appName: "Claude Desktop",
    installKind: "mcp",
    target: "claude-desktop",
    scope: "user",
    mode: {
      label: "Read/search via MCP",
      detail:
        "Recommended default. Write-capable MCP can stay an advanced CLI step.",
    },
  },
  {
    id: "cursor-mcp",
    appName: "Cursor",
    installKind: "mcp",
    target: "cursor",
    scope: "user",
    mode: {
      label: "Read/search via MCP",
      detail: "Recommended default for editor-side agent access.",
    },
  },
  {
    id: "codex-skill",
    appName: "Codex",
    installKind: "skill",
    target: "codex",
    scope: "user",
    mode: {
      label: "Read/search via skill",
      detail:
        "Fastest setup for Codex CLI. MCP remains available separately if needed later.",
    },
  },
  {
    id: "opencode-skill",
    appName: "OpenCode",
    installKind: "skill",
    target: "opencode",
    scope: "user",
    mode: {
      label: "Read/search via skill",
      detail: "Recommended default. Uses the existing skill install path.",
    },
  },
  {
    id: "openclaw-skill",
    appName: "OpenClaw",
    installKind: "skill",
    target: "openclaw",
    scope: "user",
    mode: {
      label: "Read/search via skill",
      detail:
        "Recommended default for local agent access without manual file edits.",
    },
  },
] as const;

export async function getConnectorStatuses(overrides?: {
  cwd?: string;
  homeDir?: string;
}): Promise<ConnectorStatus[]> {
  const statuses = await Promise.all(
    CONNECTOR_DEFINITIONS.map(async (definition) => {
      if (definition.installKind === "skill") {
        const paths = resolveSkillPaths({
          scope: definition.scope,
          target: definition.target,
          ...overrides,
        });
        const skillMdPath = `${paths.gnoDir}/SKILL.md`;
        const installed = await Bun.file(skillMdPath).exists();
        return {
          id: definition.id,
          appName: definition.appName,
          installKind: definition.installKind,
          target: definition.target,
          scope: definition.scope,
          installed,
          path: paths.gnoDir,
          summary: installed
            ? `${definition.appName} skill is installed.`
            : `${definition.appName} skill is not installed yet.`,
          nextAction: installed
            ? "Restart the agent to reload the skill."
            : "Install the skill from the app.",
          mode: definition.mode,
        } satisfies ConnectorStatus;
      }

      const status = await checkMcpTargetStatus(
        definition.target,
        definition.scope,
        overrides ?? {}
      );
      return {
        id: definition.id,
        appName: definition.appName,
        installKind: definition.installKind,
        target: definition.target,
        scope: definition.scope,
        installed: status.configured,
        path: status.configPath,
        summary: status.configured
          ? `${definition.appName} MCP is configured.`
          : `${definition.appName} MCP is not configured yet.`,
        nextAction: status.configured
          ? `Restart ${definition.appName} to reload the server.`
          : "Install the MCP connector from the app.",
        mode: definition.mode,
        error: status.error,
      } satisfies ConnectorStatus;
    })
  );

  return statuses;
}

export async function installConnector(
  id: string,
  overrides?: { cwd?: string; homeDir?: string }
): Promise<ConnectorStatus> {
  const definition = CONNECTOR_DEFINITIONS.find((entry) => entry.id === id);
  if (!definition) {
    throw new Error(`Unknown connector: ${id}`);
  }

  if (definition.installKind === "skill") {
    await installSkillToTarget(
      definition.scope,
      definition.target,
      true,
      overrides
    );
  } else {
    await installMcpToTarget(
      definition.target,
      definition.scope,
      buildMcpServerEntry({ enableWrite: false }),
      {
        force: true,
        dryRun: false,
        ...overrides,
      }
    );
  }

  const [status] = await getConnectorStatuses(overrides).then((all) =>
    all.filter((entry) => entry.id === id)
  );
  if (!status) {
    throw new Error(`Failed to reload connector: ${id}`);
  }
  return status;
}

export function getConnectorDisplayName(id: string): string {
  const definition = CONNECTOR_DEFINITIONS.find((entry) => entry.id === id);
  if (!definition) {
    return id;
  }

  if (definition.installKind === "mcp") {
    return `${definition.appName} (${getTargetDisplayName(definition.target)})`;
  }

  return definition.appName;
}
