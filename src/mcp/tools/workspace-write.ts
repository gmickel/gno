/**
 * MCP workspace write tools for note/file operations.
 *
 * @module src/mcp/tools/workspace-write
 */

// node:fs/promises for mkdir (no Bun equivalent for structure ops)
import { mkdir } from "node:fs/promises";
// node:path for dirname/join (no Bun path utils)
import { dirname, join } from "node:path";

import type { Collection } from "../../config/types";
import type { ToolContext } from "../server";

import { getDocumentCapabilities } from "../../core/document-capabilities";
import { MCP_ERRORS } from "../../core/errors";
import { withWriteLock } from "../../core/file-lock";
import {
  copyFilePath,
  createFolderPath,
  renameFilePath,
} from "../../core/file-ops";
import {
  buildRefactorWarnings,
  planCreateFolder,
  planDuplicateRefactor,
  planMoveRefactor,
  planRenameRefactor,
} from "../../core/file-refactors";
import { defaultSyncService } from "../../ingestion";
import { runTool, type ToolResult } from "./index";

interface CreateFolderInput {
  collection: string;
  name: string;
  parentPath?: string;
}

interface RenameNoteInput {
  ref: string;
  name: string;
}

interface MoveNoteInput {
  ref: string;
  folderPath: string;
  name?: string;
}

interface DuplicateNoteInput {
  ref: string;
  folderPath?: string;
  name?: string;
}

function resolveCollection(ctx: ToolContext, name: string): Collection {
  const normalized = name.trim().toLowerCase();
  const collection = ctx.collections.find((entry) => entry.name === normalized);
  if (!collection) {
    throw new Error(
      `${MCP_ERRORS.NOT_FOUND.code}: Collection not found: ${name}`
    );
  }
  return collection;
}

async function resolveDocByRef(ctx: ToolContext, ref: string) {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new Error(`${MCP_ERRORS.INVALID_INPUT.code}: ref cannot be empty`);
  }

  if (trimmed.startsWith("#")) {
    const result = await ctx.store.getDocumentByDocid(trimmed);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    if (!result.value) {
      throw new Error(
        `${MCP_ERRORS.NOT_FOUND.code}: Document not found: ${ref}`
      );
    }
    return result.value;
  }

  if (trimmed.startsWith("gno://")) {
    const result = await ctx.store.getDocumentByUri(trimmed);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    if (!result.value) {
      throw new Error(
        `${MCP_ERRORS.NOT_FOUND.code}: Document not found: ${ref}`
      );
    }
    return result.value;
  }

  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    throw new Error(
      `${MCP_ERRORS.INVALID_INPUT.code}: ref must be #docid, gno:// URI, or collection/path`
    );
  }

  const collection = trimmed.slice(0, slash).toLowerCase();
  const relPath = trimmed.slice(slash + 1);
  const result = await ctx.store.getDocument(collection, relPath);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  if (!result.value) {
    throw new Error(`${MCP_ERRORS.NOT_FOUND.code}: Document not found: ${ref}`);
  }
  return result.value;
}

async function getRefactorSnapshot(ctx: ToolContext, documentId: number) {
  const [linksResult, backlinksResult] = await Promise.all([
    ctx.store.getLinksForDoc(documentId),
    ctx.store.getBacklinksForDoc(documentId),
  ]);
  if (!linksResult.ok) {
    throw new Error(linksResult.error.message);
  }
  if (!backlinksResult.ok) {
    throw new Error(backlinksResult.error.message);
  }
  return {
    backlinks: backlinksResult.value.length,
    wikiLinks: linksResult.value.filter((entry) => entry.linkType === "wiki")
      .length,
    markdownLinks: linksResult.value.filter(
      (entry) => entry.linkType === "markdown"
    ).length,
  };
}

function ensureEditable(doc: {
  sourceExt: string;
  sourceMime: string;
  mirrorHash: string | null;
}) {
  const capabilities = getDocumentCapabilities({
    sourceExt: doc.sourceExt,
    sourceMime: doc.sourceMime,
    contentAvailable: doc.mirrorHash !== null,
  });
  if (!capabilities.editable) {
    throw new Error(
      `${MCP_ERRORS.CONFLICT.code}: ${
        capabilities.reason ?? "Document is read-only in place."
      }`
    );
  }
}

export function handleCreateFolder(
  args: CreateFolderInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_create_folder",
    async () => {
      if (!ctx.enableWrite) {
        throw new Error("Write tools disabled. Start MCP with --enable-write.");
      }

      return withWriteLock(ctx.writeLockPath, async () => {
        const collection = resolveCollection(ctx, args.collection);
        const folderPath = planCreateFolder({
          parentPath: args.parentPath,
          name: args.name,
        });
        const fullPath = join(collection.path, folderPath);
        await createFolderPath(fullPath);
        return {
          collection: collection.name,
          folderPath,
          path: fullPath,
        };
      });
    },
    (data) => `Created folder ${data.folderPath} in ${data.collection}`
  );
}

export function handleRenameNote(
  args: RenameNoteInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_rename_note",
    async () => {
      if (!ctx.enableWrite) {
        throw new Error("Write tools disabled. Start MCP with --enable-write.");
      }

      return withWriteLock(ctx.writeLockPath, async () => {
        const doc = await resolveDocByRef(ctx, args.ref);
        ensureEditable(doc);
        const collection = resolveCollection(ctx, doc.collection);
        const plan = planRenameRefactor({
          collection: collection.name,
          currentRelPath: doc.relPath,
          nextName: args.name,
        });
        const currentPath = join(collection.path, doc.relPath);
        const nextPath = join(collection.path, plan.nextRelPath);
        await renameFilePath(currentPath, nextPath);
        await defaultSyncService.syncCollection(collection, ctx.store, {
          runUpdateCmd: false,
        });
        return {
          uri: plan.nextUri,
          relPath: plan.nextRelPath,
          warnings: buildRefactorWarnings(
            await getRefactorSnapshot(ctx, doc.id),
            { filenameChanged: true }
          ).warnings,
        };
      });
    },
    (data) => `Renamed note to ${data.relPath}`
  );
}

export function handleMoveNote(
  args: MoveNoteInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_move_note",
    async () => {
      if (!ctx.enableWrite) {
        throw new Error("Write tools disabled. Start MCP with --enable-write.");
      }

      return withWriteLock(ctx.writeLockPath, async () => {
        const doc = await resolveDocByRef(ctx, args.ref);
        ensureEditable(doc);
        const collection = resolveCollection(ctx, doc.collection);
        const plan = planMoveRefactor({
          collection: collection.name,
          currentRelPath: doc.relPath,
          folderPath: args.folderPath,
          nextName: args.name,
        });
        const currentPath = join(collection.path, doc.relPath);
        const nextPath = join(collection.path, plan.nextRelPath);
        await mkdir(dirname(nextPath), { recursive: true });
        await renameFilePath(currentPath, nextPath);
        await defaultSyncService.syncCollection(collection, ctx.store, {
          runUpdateCmd: false,
        });
        return {
          uri: plan.nextUri,
          relPath: plan.nextRelPath,
          warnings: buildRefactorWarnings(
            await getRefactorSnapshot(ctx, doc.id),
            {
              folderChanged: true,
              filenameChanged: Boolean(args.name),
            }
          ).warnings,
        };
      });
    },
    (data) => `Moved note to ${data.relPath}`
  );
}

export function handleDuplicateNote(
  args: DuplicateNoteInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_duplicate_note",
    async () => {
      if (!ctx.enableWrite) {
        throw new Error("Write tools disabled. Start MCP with --enable-write.");
      }

      return withWriteLock(ctx.writeLockPath, async () => {
        const doc = await resolveDocByRef(ctx, args.ref);
        ensureEditable(doc);
        const collection = resolveCollection(ctx, doc.collection);
        const docsResult = await ctx.store.listDocuments(collection.name);
        if (!docsResult.ok) {
          throw new Error(docsResult.error.message);
        }
        const plan = planDuplicateRefactor({
          collection: collection.name,
          currentRelPath: doc.relPath,
          folderPath: args.folderPath,
          nextName: args.name,
          existingRelPaths: docsResult.value.map((entry) => entry.relPath),
        });
        const currentPath = join(collection.path, doc.relPath);
        const nextPath = join(collection.path, plan.nextRelPath);
        await mkdir(dirname(nextPath), { recursive: true });
        await copyFilePath(currentPath, nextPath);
        await defaultSyncService.syncCollection(collection, ctx.store, {
          runUpdateCmd: false,
        });
        return {
          uri: plan.nextUri,
          relPath: plan.nextRelPath,
          warnings: buildRefactorWarnings(
            await getRefactorSnapshot(ctx, doc.id)
          ).warnings,
        };
      });
    },
    (data) => `Duplicated note to ${data.relPath}`
  );
}
