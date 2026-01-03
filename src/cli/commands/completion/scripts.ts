/**
 * Shell completion scripts for bash, zsh, and fish.
 *
 * @module src/cli/commands/completion/scripts
 */

import { CLI_NAME } from "../../../app/constants.js";

export type Shell = "bash" | "zsh" | "fish";
export const SUPPORTED_SHELLS: Shell[] = ["bash", "zsh", "fish"];

/**
 * All gno commands and subcommands for completion.
 */
const COMMANDS = [
  "init",
  "index",
  "update",
  "embed",
  "status",
  "doctor",
  "cleanup",
  "reset",
  "search",
  "vsearch",
  "query",
  "ask",
  "get",
  "multi-get",
  "ls",
  "serve",
  "mcp",
  "mcp serve",
  "mcp install",
  "mcp uninstall",
  "mcp status",
  "collection",
  "collection add",
  "collection list",
  "collection remove",
  "collection rename",
  "context",
  "context add",
  "context list",
  "context check",
  "context rm",
  "models",
  "models list",
  "models pull",
  "models clear",
  "models path",
  "models use",
  "skill",
  "skill install",
  "skill uninstall",
  "skill show",
  "skill paths",
  "completion",
  "completion output",
  "completion install",
];

/**
 * Global flags available on all commands.
 */
const GLOBAL_FLAGS = [
  "--index",
  "--config",
  "--no-color",
  "--no-pager",
  "--verbose",
  "--yes",
  "--quiet",
  "--json",
  "--offline",
  "--help",
  "--version",
];

/**
 * Generate bash completion script.
 */
export function generateBashCompletion(): string {
  const commands = COMMANDS.filter((c) => !c.includes(" ")).join(" ");
  const subcommands: Record<string, string> = {};

  for (const cmd of COMMANDS) {
    if (cmd.includes(" ")) {
      const parts = cmd.split(" ");
      const parent = parts[0];
      const sub = parts[1];
      if (parent && sub) {
        subcommands[parent] = subcommands[parent]
          ? `${subcommands[parent]} ${sub}`
          : sub;
      }
    }
  }

  const subCases = Object.entries(subcommands)
    .map(
      ([parent, subs]) =>
        `      ${parent}) COMPREPLY=($(compgen -W "${subs}" -- "\${cur}")) ;;`
    )
    .join("\n");

  return `# ${CLI_NAME} bash completion
# Add to ~/.bashrc or ~/.bash_completion

_${CLI_NAME}_completions() {
  local cur prev cword
  # Portable: don't rely on _init_completion (requires bash-completion package)
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cword="\${COMP_CWORD}"

  local commands="${commands}"
  local global_flags="${GLOBAL_FLAGS.join(" ")}"

  # Complete subcommands for parent commands
  case "\${COMP_WORDS[1]}" in
${subCases}
  esac

  # Complete global flags
  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=($(compgen -W "\${global_flags}" -- "\${cur}"))
    return
  fi

  # Complete top-level commands
  if [[ \${cword} -eq 1 ]]; then
    COMPREPLY=($(compgen -W "\${commands}" -- "\${cur}"))
    return
  fi

  # Dynamic collection completion for -c/--collection flag
  if [[ "\${prev}" == "-c" || "\${prev}" == "--collection" ]]; then
    local collections
    collections=$(${CLI_NAME} collection list --json 2>/dev/null | grep -o '"name":"[^"]*"' | cut -d'"' -f4)
    COMPREPLY=($(compgen -W "\${collections}" -- "\${cur}"))
    return
  fi
}

complete -F _${CLI_NAME}_completions ${CLI_NAME}
`;
}

/**
 * Generate zsh completion script.
 */
export function generateZshCompletion(): string {
  const topLevel = COMMANDS.filter((c) => !c.includes(" "));
  const subcommands: Record<string, string[]> = {};

  for (const cmd of COMMANDS) {
    if (cmd.includes(" ")) {
      const parts = cmd.split(" ");
      const parent = parts[0];
      const sub = parts[1];
      if (parent && sub) {
        subcommands[parent] = subcommands[parent] || [];
        subcommands[parent].push(sub);
      }
    }
  }

  const subCases = Object.entries(subcommands)
    .map(
      ([parent, subs]) =>
        `    ${parent})
      _arguments '2:subcommand:(${subs.join(" ")})'
      ;;`
    )
    .join("\n");

  return `# ${CLI_NAME} zsh completion
# Add to ~/.zshrc or copy to a directory in $fpath
# If autoloading from fpath, add "#compdef ${CLI_NAME}" as first line

_${CLI_NAME}() {
  local -a commands
  commands=(
${topLevel.map((c) => `    '${c}:${getCommandDescription(c)}'`).join("\n")}
  )

  local -a global_flags
  global_flags=(
    '--index[index name]:name:'
    '--config[config file path]:file:_files'
    '--no-color[disable colors]'
    '--no-pager[disable paging]'
    '--verbose[verbose logging]'
    '--yes[non-interactive mode]'
    '--quiet[suppress non-essential output]'
    '--json[JSON output]'
    '--offline[offline mode]'
    '--help[show help]'
    '--version[show version]'
  )

  _arguments -C \\
    "\${global_flags[@]}" \\
    '1:command:->command' \\
    '*::arg:->args'

  case "$state" in
    command)
      _describe -t commands 'gno commands' commands
      ;;
    args)
      # words[1] is the program name in zsh, words[2] is the command
      case "\${words[2]}" in
${subCases}
      esac
      ;;
  esac
}

# Dynamic collection completion
_${CLI_NAME}_collections() {
  local -a collections
  collections=(\${(f)"$($CLI_NAME collection list --json 2>/dev/null | grep -o '"name":"[^"]*"' | cut -d'"' -f4)"})
  _describe -t collections 'collections' collections
}

# Register completion (works when sourced or autoloaded)
(( $+functions[compdef] )) && compdef _${CLI_NAME} ${CLI_NAME}
`;
}

/**
 * Generate fish completion script.
 */
export function generateFishCompletion(): string {
  const topLevel = COMMANDS.filter((c) => !c.includes(" "));
  const subcommands: Record<string, string[]> = {};

  for (const cmd of COMMANDS) {
    if (cmd.includes(" ")) {
      const parts = cmd.split(" ");
      const parent = parts[0];
      const sub = parts[1];
      if (parent && sub) {
        subcommands[parent] = subcommands[parent] || [];
        subcommands[parent].push(sub);
      }
    }
  }

  const topLevelCompletions = topLevel
    .map(
      (c) =>
        `complete -c ${CLI_NAME} -f -n "__fish_use_subcommand" -a "${c}" -d "${getCommandDescription(c)}"`
    )
    .join("\n");

  const subCompletions = Object.entries(subcommands)
    .flatMap(([parent, subs]) =>
      subs.map(
        (sub) =>
          `complete -c ${CLI_NAME} -f -n "__fish_seen_subcommand_from ${parent}" -a "${sub}" -d "${getCommandDescription(`${parent} ${sub}`)}"`
      )
    )
    .join("\n");

  return `# ${CLI_NAME} fish completion
# Copy to ~/.config/fish/completions/${CLI_NAME}.fish

# Disable file completion by default
complete -c ${CLI_NAME} -f

# Global flags
complete -c ${CLI_NAME} -l index -d "index name" -r
complete -c ${CLI_NAME} -l config -d "config file path" -r
complete -c ${CLI_NAME} -l no-color -d "disable colors"
complete -c ${CLI_NAME} -l verbose -d "verbose logging"
complete -c ${CLI_NAME} -l yes -d "non-interactive mode"
complete -c ${CLI_NAME} -l quiet -d "suppress non-essential output"
complete -c ${CLI_NAME} -l json -d "JSON output"
complete -c ${CLI_NAME} -l offline -d "offline mode"
complete -c ${CLI_NAME} -s h -l help -d "show help"
complete -c ${CLI_NAME} -s V -l version -d "show version"

# Top-level commands
${topLevelCompletions}

# Subcommands
${subCompletions}

# Dynamic collection completion for -c/--collection
complete -c ${CLI_NAME} -s c -l collection -d "filter by collection" -xa "(${CLI_NAME} collection list --json 2>/dev/null | string match -r '"name":"[^"]*"' | string replace -r '"name":"([^"]*)"' '$1')"
`;
}

/**
 * Get script for a specific shell.
 */
export function getCompletionScript(shell: Shell): string {
  switch (shell) {
    case "bash":
      return generateBashCompletion();
    case "zsh":
      return generateZshCompletion();
    case "fish":
      return generateFishCompletion();
  }
}

/**
 * Get brief description for a command.
 */
function getCommandDescription(cmd: string): string {
  const descriptions: Record<string, string> = {
    init: "Initialize GNO configuration",
    index: "Index files from collections",
    update: "Sync files from disk",
    embed: "Generate embeddings",
    status: "Show index status",
    doctor: "Diagnose configuration issues",
    cleanup: "Clean orphaned data",
    reset: "Delete all GNO data",
    search: "BM25 keyword search",
    vsearch: "Vector similarity search",
    query: "Hybrid search with reranking",
    ask: "Query with grounded answer",
    get: "Get document by URI",
    "multi-get": "Get multiple documents",
    ls: "List indexed documents",
    serve: "Start web UI server",
    mcp: "MCP server and configuration",
    "mcp serve": "Start MCP server",
    "mcp install": "Install MCP server to client",
    "mcp uninstall": "Remove MCP server from client",
    "mcp status": "Show MCP installation status",
    collection: "Manage collections",
    "collection add": "Add a collection",
    "collection list": "List collections",
    "collection remove": "Remove a collection",
    "collection rename": "Rename a collection",
    context: "Manage context items",
    "context add": "Add context metadata",
    "context list": "List context items",
    "context check": "Check context configuration",
    "context rm": "Remove context item",
    models: "Manage LLM models",
    "models list": "List available models",
    "models pull": "Download models",
    "models clear": "Clear model cache",
    "models path": "Show model cache path",
    "models use": "Switch active model preset",
    skill: "Manage GNO agent skill",
    "skill install": "Install GNO skill",
    "skill uninstall": "Uninstall GNO skill",
    "skill show": "Preview skill files",
    "skill paths": "Show skill installation paths",
    completion: "Shell completion scripts",
    "completion install": "Install shell completions",
  };
  return descriptions[cmd] || cmd;
}
