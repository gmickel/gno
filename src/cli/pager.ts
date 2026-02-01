/**
 * Pager utility for long CLI output.
 * Pipes output through less/more when terminal height exceeded.
 *
 * @module src/cli/pager
 */

// node:os - no Bun equivalent for platform()
import { platform } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PagerOptions {
  /** Force disable paging (--no-pager flag) */
  noPager?: boolean;
  /** Override terminal height detection */
  terminalHeight?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pager Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find available pager command.
 * Priority: $PAGER env → less (with -R for colors) → more
 */
function findPager(): string[] | null {
  // Check $PAGER env first (cross-platform)
  const pagerEnv = process.env.PAGER;
  if (pagerEnv) {
    // Split in case user has args like "less -R"
    return pagerEnv.split(/\s+/);
  }

  // Platform-specific fallbacks
  const isWindows = platform() === "win32";

  if (isWindows) {
    // Windows: use more.com (basic but universally available)
    return ["more.com"];
  }

  // Unix: prefer less with -R (preserve ANSI colors)
  return ["less", "-R"];
}

/**
 * Check if paging should be enabled.
 */
function shouldPage(options: PagerOptions): boolean {
  // Explicitly disabled
  if (options.noPager) {
    return false;
  }

  // Not a TTY (piped output)
  if (!process.stdout.isTTY) {
    return false;
  }

  return true;
}

/**
 * Get terminal height.
 */
function getTerminalHeight(options: PagerOptions): number {
  if (options.terminalHeight !== undefined) {
    return options.terminalHeight;
  }
  return process.stdout.rows || 24; // Default to 24 if unknown
}

// ─────────────────────────────────────────────────────────────────────────────
// Pager Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pager that buffers output and pipes through pager if needed.
 */
export class Pager {
  private options: PagerOptions;
  private buffer: string[] = [];
  private terminalHeight: number;
  private pagerProcess: ReturnType<typeof Bun.spawn> | null = null;
  private enabled: boolean;

  constructor(options: PagerOptions = {}) {
    this.options = options;
    this.terminalHeight = getTerminalHeight(options);
    this.enabled = shouldPage(options);
  }

  /**
   * Write a line to the pager buffer.
   */
  writeLine(line: string): void {
    this.buffer.push(line);
  }

  /**
   * Write multiple lines to the pager buffer.
   */
  writeLines(lines: string[]): void {
    this.buffer.push(...lines);
  }

  /**
   * Write raw content (may contain newlines).
   */
  write(content: string): void {
    const lines = content.split("\n");
    // Don't add empty string from trailing newline
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    this.buffer.push(...lines);
  }

  /**
   * Flush buffer to stdout, using pager if content exceeds terminal height.
   */
  async flush(): Promise<void> {
    const content = this.buffer.join("\n");
    const lineCount = this.buffer.length;

    // If paging disabled or content fits in terminal, write directly
    if (!this.enabled || lineCount <= this.terminalHeight - 1) {
      if (content) {
        process.stdout.write(content + "\n");
      }
      return;
    }

    // Try to spawn pager
    const pagerCmd = findPager();
    if (!pagerCmd) {
      // No pager available, write directly
      process.stdout.write(content + "\n");
      return;
    }

    // Spawn pager and pipe content
    await this.spawnPager(pagerCmd, content);
  }

  /**
   * Spawn pager process and pipe content.
   */
  private async spawnPager(pagerCmd: string[], content: string): Promise<void> {
    const [cmd, ...args] = pagerCmd;
    if (!cmd) {
      process.stdout.write(content + "\n");
      return;
    }

    try {
      const proc = Bun.spawn([cmd, ...args], {
        stdin: "pipe",
        stdout: "inherit",
        stderr: "inherit",
      });
      this.pagerProcess = proc;

      // Write content to pager stdin
      if (proc.stdin) {
        await proc.stdin.write(content + "\n");
        await proc.stdin.end();
      }

      // Wait for pager to exit
      await proc.exited;
      this.pagerProcess = null;
    } catch {
      // Spawn failed - fall back to direct output
      process.stdout.write(content + "\n");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convenience function to page content.
 * @param content Content to potentially page
 * @param options Pager options
 */
export async function pageContent(
  content: string,
  options: PagerOptions = {}
): Promise<void> {
  const pager = new Pager(options);
  pager.write(content);
  await pager.flush();
}
