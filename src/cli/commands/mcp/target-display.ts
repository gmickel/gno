import type { McpTarget } from "./paths.js";

export function getTargetDisplayName(target: McpTarget): string {
  switch (target) {
    case "claude-desktop":
      return "Claude Desktop";
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "zed":
      return "Zed";
    case "windsurf":
      return "Windsurf";
    case "opencode":
      return "OpenCode";
    case "amp":
      return "Amp";
    case "lmstudio":
      return "LM Studio";
    case "librechat":
      return "LibreChat";
    default: {
      const exhaustive: never = target;
      throw new Error(`Unknown target: ${String(exhaustive)}`);
    }
  }
}
