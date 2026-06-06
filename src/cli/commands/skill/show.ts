/**
 * Show/preview GNO skill files without installing.
 *
 * @module src/cli/commands/skill/show
 */

import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { CliError } from "../../errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Source Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

function getSkillSourceDir(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, "../../../../assets/skill");
}

// ─────────────────────────────────────────────────────────────────────────────
// Show Command
// ─────────────────────────────────────────────────────────────────────────────

export interface ShowOptions {
  file?: string;
  all?: boolean;
}

const DEFAULT_FILE = "SKILL.md";

async function listMarkdownFiles(
  rootDir: string,
  currentDir = rootDir,
  prefix = ""
): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(currentDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(rootDir, fullPath, relativePath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(relativePath);
    }
  }

  return files.sort();
}

function resolveSkillMarkdownPath(sourceDir: string, fileName: string): string {
  if (
    isAbsolute(fileName) ||
    fileName.includes("\\") ||
    fileName.trim() === ""
  ) {
    throw new CliError("VALIDATION", `Invalid skill file path: ${fileName}`);
  }

  const normalized = posix.normalize(fileName);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    !normalized.endsWith(".md")
  ) {
    throw new CliError("VALIDATION", `Invalid skill file path: ${fileName}`);
  }

  const fullPath = join(sourceDir, ...normalized.split("/"));
  const rel = relative(sourceDir, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new CliError("VALIDATION", `Invalid skill file path: ${fileName}`);
  }

  return fullPath;
}

/**
 * Show skill file content.
 */
export async function showSkill(opts: ShowOptions = {}): Promise<void> {
  const sourceDir = getSkillSourceDir();

  let mdFiles: string[];
  try {
    mdFiles = await listMarkdownFiles(sourceDir);
  } catch {
    throw new CliError("RUNTIME", `Skill files not found at ${sourceDir}`);
  }

  if (opts.all) {
    // Show all files with separators
    for (const file of mdFiles) {
      process.stdout.write(`--- ${file} ---\n`);
      const content = await Bun.file(
        resolveSkillMarkdownPath(sourceDir, file)
      ).text();
      process.stdout.write(`${content}\n`);
      process.stdout.write("\n");
    }
  } else {
    // Show single file
    const fileName = opts.file ?? DEFAULT_FILE;

    if (!mdFiles.includes(fileName)) {
      resolveSkillMarkdownPath(sourceDir, fileName);
      throw new CliError(
        "VALIDATION",
        `Unknown file: ${fileName}. Available: ${mdFiles.join(", ")}`
      );
    }

    const content = await Bun.file(
      resolveSkillMarkdownPath(sourceDir, fileName)
    ).text();
    process.stdout.write(`${content}\n`);
  }

  // Always list available files at end
  process.stdout.write(`\nFiles: ${mdFiles.join(", ")}\n`);
}
