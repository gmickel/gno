/**
 * Shell completion commands - output scripts or auto-install.
 *
 * @module src/cli/commands/completion/completion
 */

import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { CLI_NAME } from "../../../app/constants.js";
import { CliError } from "../../errors.js";
import {
  getCompletionScript,
  SUPPORTED_SHELLS,
  type Shell,
} from "./scripts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface OutputOptions {
  shell: Shell;
}

export interface InstallOptions {
  /** Override shell detection */
  shell?: Shell;
  /** JSON output */
  json?: boolean;
}

interface InstallResult {
  shell: Shell;
  path: string;
  action: "installed" | "already_installed";
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect user's current shell.
 */
function detectShell(): Shell | undefined {
  // Check $SHELL env
  const shellEnv = process.env.SHELL || "";
  if (shellEnv.includes("zsh")) return "zsh";
  if (shellEnv.includes("bash")) return "bash";
  if (shellEnv.includes("fish")) return "fish";

  // Check parent process name on Unix
  // This is less reliable but can help
  const parentName = process.env._ || "";
  if (parentName.includes("zsh")) return "zsh";
  if (parentName.includes("bash")) return "bash";
  if (parentName.includes("fish")) return "fish";

  return undefined;
}

/**
 * Get the appropriate rc file for a shell.
 */
function getShellRcPath(shell: Shell): string {
  const home = homedir();
  switch (shell) {
    case "bash":
      // Prefer .bashrc, but .bash_profile on macOS
      return process.platform === "darwin"
        ? join(home, ".bash_profile")
        : join(home, ".bashrc");
    case "zsh":
      return join(home, ".zshrc");
    case "fish":
      return join(home, ".config", "fish", "completions", `${CLI_NAME}.fish`);
  }
}

/**
 * Check if completion is already installed.
 */
async function isCompletionInstalled(shell: Shell): Promise<boolean> {
  const path = getShellRcPath(shell);

  // For fish, check if file exists
  if (shell === "fish") {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  // For bash/zsh, check for shell-specific patterns
  try {
    const content = await Bun.file(path).text();
    // Generic header comment
    const header = `# ${CLI_NAME}`;
    // Bash function name
    const bashFn = `_${CLI_NAME}_completions`;
    // Zsh-specific patterns (function definition or completion header)
    const zshFn = `_${CLI_NAME}()`;

    if (shell === "bash") {
      return content.includes(header) || content.includes(bashFn);
    }
    if (shell === "zsh") {
      return content.includes(header) || content.includes(zshFn);
    }
    return false;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Output completion script to stdout.
 */
export function completionOutput(options: OutputOptions): string {
  const { shell } = options;

  if (!SUPPORTED_SHELLS.includes(shell)) {
    throw new CliError(
      "VALIDATION",
      `Unsupported shell: ${shell}. Supported: ${SUPPORTED_SHELLS.join(", ")}`
    );
  }

  return getCompletionScript(shell);
}

/**
 * Auto-install completion to user's shell config.
 */
export async function completionInstall(
  options: InstallOptions
): Promise<void> {
  const { json = false } = options;
  let { shell } = options;

  // Auto-detect shell if not specified
  if (!shell) {
    shell = detectShell();
    if (!shell) {
      throw new CliError(
        "VALIDATION",
        "Could not detect shell. Please specify: gno completion install --shell <bash|zsh|fish>"
      );
    }
  }

  if (!SUPPORTED_SHELLS.includes(shell)) {
    throw new CliError(
      "VALIDATION",
      `Unsupported shell: ${shell}. Supported: ${SUPPORTED_SHELLS.join(", ")}`
    );
  }

  // Check if already installed
  const alreadyInstalled = await isCompletionInstalled(shell);
  const rcPath = getShellRcPath(shell);
  const script = getCompletionScript(shell);

  let result: InstallResult;

  if (alreadyInstalled) {
    result = { shell, path: rcPath, action: "already_installed" };
  } else {
    // Install completion
    if (shell === "fish") {
      // Fish uses a separate file in completions dir
      const dir = join(homedir(), ".config", "fish", "completions");
      await mkdir(dir, { recursive: true });
      await writeFile(rcPath, script, "utf-8");
    } else {
      // Bash/zsh append to rc file
      const separator = "\n\n";
      await appendFile(rcPath, separator + script, "utf-8");
    }
    result = { shell, path: rcPath, action: "installed" };
  }

  // Output result
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    if (result.action === "already_installed") {
      process.stdout.write(`Completion already installed for ${shell}.\n`);
      process.stdout.write(`Config: ${result.path}\n`);
    } else {
      process.stdout.write(`Completion installed for ${shell}.\n`);
      process.stdout.write(`Config: ${result.path}\n`);
      process.stdout.write(`\nRestart your shell or run:\n`);
      if (shell === "fish") {
        process.stdout.write(`  source ${result.path}\n`);
      } else {
        process.stdout.write(`  source ${result.path}\n`);
      }
    }
  }
}
