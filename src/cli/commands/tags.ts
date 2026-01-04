/**
 * gno tags command implementation.
 * List, add, and remove tags from documents.
 *
 * @module src/cli/commands/tags
 */

import { open, unlink } from "node:fs/promises"; // No Bun equivalents for atomic create/unlink
import { dirname, join as pathJoin } from "node:path"; // No Bun path utils

import type { TagCount } from "../../store/types";

import { normalizeTag, validateTag } from "../../core/tags";
import { initStore } from "./shared";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TagsListOptions {
  /** Override config path */
  configPath?: string;
  /** Filter by collection */
  collection?: string;
  /** Filter by tag prefix */
  prefix?: string;
  /** JSON output */
  json?: boolean;
  /** Markdown output */
  md?: boolean;
}

export type TagsListResult =
  | { success: true; data: TagsListResponse }
  | { success: false; error: string; isValidation?: boolean };

export interface TagsListResponse {
  tags: TagCount[];
  meta: {
    totalTags: number;
    collection?: string;
    prefix?: string;
  };
}

export interface TagsAddOptions {
  /** Override config path */
  configPath?: string;
  /** JSON output */
  json?: boolean;
}

export type TagsAddResult =
  | {
      success: true;
      data: { docid: string; tag: string; wroteToFile: boolean };
    }
  | { success: false; error: string; isValidation?: boolean };

export interface TagsRmOptions {
  /** Override config path */
  configPath?: string;
  /** JSON output */
  json?: boolean;
}

export type TagsRmResult =
  | {
      success: true;
      data: { docid: string; tag: string; removedFromFile: boolean };
    }
  | { success: false; error: string; isValidation?: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Lock file for concurrent write safety
// ─────────────────────────────────────────────────────────────────────────────

const LOCK_FILE = ".mcp-write.lock";
const LOCK_TIMEOUT = 5000; // 5 seconds
const LOCK_RETRY_DELAY = 100; // 100ms between retries

/**
 * Acquire a file lock for safe concurrent writes.
 * Uses O_EXCL for atomic creation - fails if file exists.
 * Returns unlock function on success, throws on timeout.
 */
async function acquireLock(dirPath: string): Promise<() => Promise<void>> {
  const lockPath = pathJoin(dirPath, LOCK_FILE);
  const startTime = Date.now();

  while (Date.now() - startTime < LOCK_TIMEOUT) {
    try {
      // Attempt atomic create with O_EXCL - fails if file exists
      const fd = await open(lockPath, "wx");
      await fd.write(`${process.pid}\n`);
      await fd.close();

      // Lock acquired - return unlock function
      return async () => {
        try {
          await unlink(lockPath);
        } catch {
          // Ignore cleanup errors (file may already be deleted)
        }
      };
    } catch (error) {
      // EEXIST means lock exists, wait and retry
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        await Bun.sleep(LOCK_RETRY_DELAY);
        continue;
      }
      // Other errors (ENOENT for missing dir, etc.) - rethrow
      throw error;
    }
  }

  throw new Error(`Timeout acquiring lock: ${lockPath}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter manipulation
// ─────────────────────────────────────────────────────────────────────────────

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n|$)/;

/**
 * Add a tag to YAML frontmatter.
 * Creates frontmatter if missing.
 * Returns updated content.
 */
function addTagToFrontmatter(content: string, tag: string): string {
  const match = FRONTMATTER_REGEX.exec(content);

  if (!match) {
    // No frontmatter - create it
    return `---\ntags:\n  - ${tag}\n---\n\n${content}`;
  }

  const frontmatter = match[1] ?? "";
  const afterFrontmatter = content.slice(match[0].length);

  // Check if tags field exists
  const tagsLineMatch = /^(tags:\s*)(.*)$/m.exec(frontmatter);

  if (!tagsLineMatch) {
    // No tags field - add it
    const newFrontmatter = `${frontmatter.trimEnd()}\ntags:\n  - ${tag}`;
    return `---\n${newFrontmatter}\n---\n${afterFrontmatter}`;
  }

  // Tags field exists - parse and add
  const beforeTags = frontmatter.slice(0, tagsLineMatch.index);
  const tagsLine = tagsLineMatch[0];
  const afterTagsLine = frontmatter.slice(
    tagsLineMatch.index + tagsLine.length
  );

  const tagsValue = tagsLineMatch[2]?.trim() ?? "";

  // Handle inline array format: tags: [a, b]
  const inlineArrayMatch = /^\[([^\]]*)\]$/.exec(tagsValue);
  if (inlineArrayMatch) {
    const existing =
      inlineArrayMatch[1]
        ?.split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0) ?? [];
    if (existing.some((t) => normalizeTag(t) === tag)) {
      return content; // Tag already exists
    }
    const newTags = [...existing, tag].join(", ");
    const newTagsLine = `tags: [${newTags}]`;
    const newFrontmatter = `${beforeTags}${newTagsLine}${afterTagsLine}`;
    return `---\n${newFrontmatter}\n---\n${afterFrontmatter}`;
  }

  // Handle comma-separated format: tags: a, b
  if (tagsValue.length > 0 && !tagsValue.startsWith("-")) {
    const existing = tagsValue.split(",").map((t) => t.trim());
    if (existing.some((t) => normalizeTag(t) === tag)) {
      return content; // Tag already exists
    }
    const newTags = [...existing, tag].join(", ");
    const newTagsLine = `tags: ${newTags}`;
    const newFrontmatter = `${beforeTags}${newTagsLine}${afterTagsLine}`;
    return `---\n${newFrontmatter}\n---\n${afterFrontmatter}`;
  }

  // Handle block array format or empty tags:
  // Find existing array items
  const existingTags: string[] = [];
  const remainingLines = afterTagsLine.split("\n");

  for (const line of remainingLines) {
    const itemMatch = /^\s+-\s+(.+)$/.exec(line);
    if (itemMatch?.[1]) {
      existingTags.push(itemMatch[1].trim());
    } else if (line.trim().length > 0 && !line.startsWith(" ")) {
      break;
    }
  }

  // Check if tag already exists
  if (existingTags.some((t) => normalizeTag(t) === tag)) {
    return content; // Already exists
  }

  // Add new tag to array
  const newTagLine = `  - ${tag}`;
  const insertPoint = tagsLineMatch.index + tagsLine.length;
  const newFrontmatter =
    frontmatter.slice(0, insertPoint) +
    `\n${newTagLine}` +
    frontmatter.slice(insertPoint);

  return `---\n${newFrontmatter}\n---\n${afterFrontmatter}`;
}

/**
 * Remove a tag from YAML frontmatter.
 * Returns updated content.
 */
function removeTagFromFrontmatter(content: string, tag: string): string {
  const match = FRONTMATTER_REGEX.exec(content);

  if (!match) {
    return content; // No frontmatter
  }

  const frontmatter = match[1] ?? "";
  const afterFrontmatter = content.slice(match[0].length);

  // Check if tags field exists
  const tagsLineMatch = /^(tags:\s*)(.*)$/m.exec(frontmatter);

  if (!tagsLineMatch) {
    return content; // No tags field
  }

  const beforeTags = frontmatter.slice(0, tagsLineMatch.index);
  const tagsLine = tagsLineMatch[0];
  const afterTagsLine = frontmatter.slice(
    tagsLineMatch.index + tagsLine.length
  );

  const tagsValue = tagsLineMatch[2]?.trim() ?? "";
  const normalizedTag = normalizeTag(tag);

  // Handle inline array format: tags: [a, b]
  const inlineArrayMatch = /^\[([^\]]*)\]$/.exec(tagsValue);
  if (inlineArrayMatch) {
    const existing =
      inlineArrayMatch[1]
        ?.split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && normalizeTag(t) !== normalizedTag) ?? [];
    if (existing.length === 0) {
      // Remove entire tags line if empty
      const newFrontmatter = `${beforeTags.trimEnd()}${afterTagsLine}`;
      return `---\n${newFrontmatter}\n---\n${afterFrontmatter}`;
    }
    const newTags = existing.join(", ");
    const newTagsLine = `tags: [${newTags}]`;
    const newFrontmatter = `${beforeTags}${newTagsLine}${afterTagsLine}`;
    return `---\n${newFrontmatter}\n---\n${afterFrontmatter}`;
  }

  // Handle comma-separated format: tags: a, b
  if (tagsValue.length > 0 && !tagsValue.startsWith("-")) {
    const existing = tagsValue
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && normalizeTag(t) !== normalizedTag);
    if (existing.length === 0) {
      const newFrontmatter = `${beforeTags.trimEnd()}${afterTagsLine}`;
      return `---\n${newFrontmatter}\n---\n${afterFrontmatter}`;
    }
    const newTags = existing.join(", ");
    const newTagsLine = `tags: ${newTags}`;
    const newFrontmatter = `${beforeTags}${newTagsLine}${afterTagsLine}`;
    return `---\n${newFrontmatter}\n---\n${afterFrontmatter}`;
  }

  // Handle block array format
  const lines = frontmatter.split("\n");
  const newLines: string[] = [];
  let inTagsArray = false;
  let removedAny = false;

  for (const line of lines) {
    if (line.match(/^tags:\s*$/)) {
      inTagsArray = true;
      newLines.push(line);
      continue;
    }

    if (inTagsArray) {
      const itemMatch = /^\s+-\s+(.+)$/.exec(line);
      if (itemMatch?.[1]) {
        if (normalizeTag(itemMatch[1].trim()) === normalizedTag) {
          removedAny = true;
          continue; // Skip this line
        }
        newLines.push(line);
      } else if (line.trim().length === 0 || line.startsWith(" ")) {
        newLines.push(line);
      } else {
        inTagsArray = false;
        newLines.push(line);
      }
    } else {
      newLines.push(line);
    }
  }

  if (!removedAny) {
    return content;
  }

  // Check if tags array is now empty
  const newFrontmatter = newLines.join("\n");
  const emptyTagsCheck = /^tags:\s*$/m.exec(newFrontmatter);
  if (emptyTagsCheck) {
    // Remove empty tags field
    const cleaned = newFrontmatter.replace(/^tags:\s*$/m, "").trim();
    return `---\n${cleaned}\n---\n${afterFrontmatter}`;
  }

  return `---\n${newFrontmatter}\n---\n${afterFrontmatter}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Command Implementations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno tags list command.
 */
export async function tagsList(
  options: TagsListOptions = {}
): Promise<TagsListResult> {
  const initResult = await initStore({ configPath: options.configPath });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }
  const { store } = initResult;

  // Normalize prefix to match tag storage (lowercase, trimmed)
  const normalizedPrefix = options.prefix
    ? normalizeTag(options.prefix)
    : undefined;

  try {
    const result = await store.getTagCounts({
      collection: options.collection,
      prefix: normalizedPrefix,
    });

    if (!result.ok) {
      return { success: false, error: result.error.message };
    }

    return {
      success: true,
      data: {
        tags: result.value,
        meta: {
          totalTags: result.value.length,
          collection: options.collection,
          prefix: normalizedPrefix,
        },
      },
    };
  } finally {
    await store.close();
  }
}

/**
 * Execute gno tags add command.
 */
export async function tagsAdd(
  docRef: string,
  tag: string,
  options: TagsAddOptions = {}
): Promise<TagsAddResult> {
  // Validate tag first
  const normalized = normalizeTag(tag);
  if (!validateTag(normalized)) {
    return {
      success: false,
      error: `Invalid tag: "${tag}". Tags must be lowercase, alphanumeric with hyphens/dots/slashes.`,
      isValidation: true,
    };
  }

  const initResult = await initStore({ configPath: options.configPath });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }
  const { store, collections } = initResult;

  try {
    // Resolve document by ref (docid or URI)
    let doc = await store.getDocumentByDocid(docRef);
    if (!doc.ok || !doc.value) {
      doc = await store.getDocumentByUri(docRef);
    }

    if (!doc.ok || !doc.value) {
      return {
        success: false,
        error: `Document not found: ${docRef}`,
        isValidation: true,
      };
    }

    const document = doc.value;

    // Add tag to DB with source='user'
    const tagsResult = await store.getTagsForDoc(document.id);
    if (!tagsResult.ok) {
      return { success: false, error: tagsResult.error.message };
    }

    const existingTags = tagsResult.value.map((t) => t.tag);
    if (existingTags.includes(normalized)) {
      // Tag already exists - silently succeed
      return {
        success: true,
        data: { docid: document.docid, tag: normalized, wroteToFile: false },
      };
    }

    // Get existing user tags and add new one
    const userTags = tagsResult.value
      .filter((t) => t.source === "user")
      .map((t) => t.tag);
    userTags.push(normalized);

    const setResult = await store.setDocTags(document.id, userTags, "user");
    if (!setResult.ok) {
      return { success: false, error: setResult.error.message };
    }

    // Write to file if markdown
    let wroteToFile = false;
    if (
      document.sourceMime === "text/markdown" ||
      document.sourceExt === ".md"
    ) {
      // Find collection path
      const collection = collections.find(
        (c) => c.name === document.collection
      );
      if (collection) {
        const filePath = pathJoin(collection.path, document.relPath);
        const file = Bun.file(filePath);

        if (await file.exists()) {
          const dirPath = dirname(filePath);
          const unlock = await acquireLock(dirPath);

          try {
            const content = await file.text();
            const updated = addTagToFrontmatter(content, normalized);

            if (updated !== content) {
              await Bun.write(filePath, updated);
              wroteToFile = true;
            }
          } finally {
            await unlock();
          }
        }
      }
    }

    return {
      success: true,
      data: { docid: document.docid, tag: normalized, wroteToFile },
    };
  } finally {
    await store.close();
  }
}

/**
 * Execute gno tags rm command.
 */
export async function tagsRm(
  docRef: string,
  tag: string,
  options: TagsRmOptions = {}
): Promise<TagsRmResult> {
  const normalized = normalizeTag(tag);

  const initResult = await initStore({ configPath: options.configPath });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }
  const { store, collections } = initResult;

  try {
    // Resolve document by ref
    let doc = await store.getDocumentByDocid(docRef);
    if (!doc.ok || !doc.value) {
      doc = await store.getDocumentByUri(docRef);
    }

    if (!doc.ok || !doc.value) {
      return {
        success: false,
        error: `Document not found: ${docRef}`,
        isValidation: true,
      };
    }

    const document = doc.value;

    // Check tag exists
    const tagsResult = await store.getTagsForDoc(document.id);
    if (!tagsResult.ok) {
      return { success: false, error: tagsResult.error.message };
    }

    const existingTag = tagsResult.value.find((t) => t.tag === normalized);
    if (!existingTag) {
      return {
        success: false,
        error: `Tag not found on document: ${tag}`,
        isValidation: true,
      };
    }

    // Remove from DB - need to remove from appropriate source
    // For user tags, update user tags list
    // For frontmatter tags, we can't remove from DB alone (will be re-added on resync)
    // But we can remove from the file which will remove on next sync

    if (existingTag.source === "user") {
      const userTags = tagsResult.value
        .filter((t) => t.source === "user" && t.tag !== normalized)
        .map((t) => t.tag);
      const setResult = await store.setDocTags(document.id, userTags, "user");
      if (!setResult.ok) {
        return { success: false, error: setResult.error.message };
      }
    }

    // Remove from file if markdown
    let removedFromFile = false;
    if (
      document.sourceMime === "text/markdown" ||
      document.sourceExt === ".md"
    ) {
      const collection = collections.find(
        (c) => c.name === document.collection
      );
      if (collection) {
        const filePath = pathJoin(collection.path, document.relPath);
        const file = Bun.file(filePath);

        if (await file.exists()) {
          const dirPath = dirname(filePath);
          const unlock = await acquireLock(dirPath);

          try {
            const content = await file.text();
            const updated = removeTagFromFrontmatter(content, normalized);

            if (updated !== content) {
              await Bun.write(filePath, updated);
              removedFromFile = true;

              // If it was a frontmatter tag, now need to remove from DB too
              if (existingTag.source === "frontmatter") {
                const frontmatterTags = tagsResult.value
                  .filter(
                    (t) => t.source === "frontmatter" && t.tag !== normalized
                  )
                  .map((t) => t.tag);
                await store.setDocTags(
                  document.id,
                  frontmatterTags,
                  "frontmatter"
                );
              }
            }
          } finally {
            await unlock();
          }
        }
      }
    }

    // If tag is from frontmatter and we couldn't update the file, error
    // (tag will reappear on next sync otherwise)
    if (existingTag.source === "frontmatter" && !removedFromFile) {
      return {
        success: false,
        error: `Cannot remove frontmatter tag "${tag}" - file is not writable or not markdown`,
        isValidation: true,
      };
    }

    return {
      success: true,
      data: { docid: document.docid, tag: normalized, removedFromFile },
    };
  } finally {
    await store.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format tags list result for output.
 */
export function formatTagsList(
  result: TagsListResult,
  options: TagsListOptions
): string {
  if (!result.success) {
    if (options.json) {
      return JSON.stringify({
        error: { code: "TAGS_LIST_FAILED", message: result.error },
      });
    }
    return `Error: ${result.error}`;
  }

  const { data } = result;

  if (options.json) {
    return JSON.stringify(data, null, 2);
  }

  if (options.md) {
    if (data.tags.length === 0) {
      return "# Tags\n\nNo tags found.";
    }
    const lines: string[] = ["# Tags", ""];
    lines.push(`*${data.meta.totalTags} tags*`);
    lines.push("");
    lines.push("| Tag | Documents |");
    lines.push("|-----|-----------|");
    for (const t of data.tags) {
      lines.push(`| \`${t.tag}\` | ${t.count} |`);
    }
    return lines.join("\n");
  }

  // Terminal format
  if (data.tags.length === 0) {
    return "No tags found.";
  }

  const lines = data.tags.map((t) => `${t.tag}\t${t.count}`);
  return lines.join("\n");
}

/**
 * Format tags add result for output.
 */
export function formatTagsAdd(
  result: TagsAddResult,
  options: TagsAddOptions
): string {
  if (!result.success) {
    if (options.json) {
      return JSON.stringify({
        error: { code: "TAGS_ADD_FAILED", message: result.error },
      });
    }
    return `Error: ${result.error}`;
  }

  if (options.json) {
    return JSON.stringify(result.data);
  }

  const { docid, tag, wroteToFile } = result.data;
  if (wroteToFile) {
    return `Added tag "${tag}" to ${docid} (updated file)`;
  }
  return `Added tag "${tag}" to ${docid}`;
}

/**
 * Format tags rm result for output.
 */
export function formatTagsRm(
  result: TagsRmResult,
  options: TagsRmOptions
): string {
  if (!result.success) {
    if (options.json) {
      return JSON.stringify({
        error: { code: "TAGS_RM_FAILED", message: result.error },
      });
    }
    return `Error: ${result.error}`;
  }

  if (options.json) {
    return JSON.stringify(result.data);
  }

  const { docid, tag, removedFromFile } = result.data;
  if (removedFromFile) {
    return `Removed tag "${tag}" from ${docid} (updated file)`;
  }
  return `Removed tag "${tag}" from ${docid}`;
}
