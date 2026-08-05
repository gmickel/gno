/**
 * MCP workspace write tools for note/file operations.
 *
 * @module src/mcp/tools/workspace-write
 */

// node:path for join (no Bun path utils)
import { join } from "node:path";
import { z } from "zod";

import type { Collection } from "../../config/types";
import type { ToolContext } from "../server";

import { getDocumentCapabilities } from "../../core/document-capabilities";
import { MCP_ERRORS } from "../../core/errors";
import { withWriteLock } from "../../core/file-lock";
import { copyFilePath, createFolderPath } from "../../core/file-ops";
import {
  applyCanonicalFileRefactor,
  assertFileRefactorSyncConverged,
  buildCanonicalRefactorPlan,
  buildDurableFileRefactorApplyDeps,
  buildRefactorWarnings,
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_SCHEMA_VERSION,
  parseRefactorApplyConfirmation,
  planCreateFolder,
  planDuplicateRefactor,
  resolveMoveTarget,
  resolveRenameTarget,
  type FileRefactorApplyResult,
  type FileRefactorPreviewPlan,
} from "../../core/file-refactors";
import { recordContentMutation } from "../../core/mutation-generations";
import {
  CaptureDestinationError,
  captureFileSyncResult,
  captureProofContainerSummary,
  captureRecordImportReason,
  defaultSyncService,
  prepareCaptureDestination,
  requireActiveCaptureDocument,
  withContentTypeRules,
} from "../../ingestion";
import { captureDestinationToolError, runTool, type ToolResult } from "./index";

interface CreateFolderInput {
  collection: string;
  name: string;
  parentPath?: string;
}

interface DuplicateNoteInput {
  ref: string;
  folderPath?: string;
  name?: string;
}

const refactorPreviewActionSchema = z.literal("preview");
const refactorApplyActionSchema = z.literal("apply");

export const renameNoteInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: refactorPreviewActionSchema,
    ref: z.string().min(1, "ref cannot be empty"),
    name: z.string().min(1, "name cannot be empty"),
  }),
  z.object({
    action: refactorApplyActionSchema,
    ref: z.string().min(1, "ref cannot be empty"),
    name: z.string().min(1, "name cannot be empty"),
    schemaVersion: z.literal(FILE_REFACTOR_SCHEMA_VERSION),
    planDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "planDigest must be a lowercase SHA-256"),
    confirmation: z.literal(FILE_REFACTOR_APPLY_CONFIRMATION),
    confirm: z.literal(true),
  }),
]);

export const moveNoteInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: refactorPreviewActionSchema,
    ref: z.string().min(1, "ref cannot be empty"),
    folderPath: z.string().min(1, "folderPath cannot be empty"),
    name: z.string().optional(),
  }),
  z.object({
    action: refactorApplyActionSchema,
    ref: z.string().min(1, "ref cannot be empty"),
    folderPath: z.string().min(1, "folderPath cannot be empty"),
    name: z.string().optional(),
    schemaVersion: z.literal(FILE_REFACTOR_SCHEMA_VERSION),
    planDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "planDigest must be a lowercase SHA-256"),
    confirmation: z.literal(FILE_REFACTOR_APPLY_CONFIRMATION),
    confirm: z.literal(true),
  }),
]);

export type RenameNoteInput = z.infer<typeof renameNoteInputSchema>;
export type MoveNoteInput = z.infer<typeof moveNoteInputSchema>;

export const RENAME_NOTE_MCP_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const MOVE_NOTE_MCP_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

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
  recordKey?: string | null;
}) {
  const capabilities = getDocumentCapabilities({
    sourceExt: doc.sourceExt,
    sourceMime: doc.sourceMime,
    contentAvailable: doc.mirrorHash !== null,
    recordKey: doc.recordKey,
  });
  if (!capabilities.editable) {
    throw new Error(
      `${MCP_ERRORS.CONFLICT.code}: ${
        capabilities.reason ?? "Document is read-only in place."
      }`
    );
  }
  return capabilities;
}

function requireWriteEnabled(ctx: ToolContext): void {
  if (!ctx.enableWrite) {
    throw new Error("Write tools disabled. Start MCP with --enable-write.");
  }
}

function requireApplyConfirmation(args: {
  schemaVersion: unknown;
  planDigest: unknown;
  confirmation: unknown;
  confirm: unknown;
}) {
  if (args.confirm !== true) {
    throw new Error(
      `${MCP_ERRORS.INVALID_INPUT.code}: confirm must be true to apply`
    );
  }
  const parsed = parseRefactorApplyConfirmation(args);
  if ("error" in parsed) {
    throw new Error(`${parsed.error}: ${parsed.message}`);
  }
  return parsed;
}

function formatPreviewSummary(plan: FileRefactorPreviewPlan): string {
  return `Preview ${plan.operation}: ${plan.source.relPath} → ${plan.target.relPath} (digest ${plan.planDigest.slice(0, 12)}…, canApply=${plan.canApply})`;
}

function formatApplySummary(result: FileRefactorApplyResult): string {
  return `${result.operation} ${result.status}: ${result.source.relPath} → ${result.target.relPath}`;
}

async function previewOrApplyRename(
  args: RenameNoteInput,
  ctx: ToolContext
): Promise<FileRefactorPreviewPlan | FileRefactorApplyResult> {
  requireWriteEnabled(ctx);
  const doc = await resolveDocByRef(ctx, args.ref);
  const capabilities = ensureEditable(doc);
  const collection = resolveCollection(ctx, doc.collection);
  const target = resolveRenameTarget({
    collection: collection.name,
    currentRelPath: doc.relPath,
    nextName: args.name,
  });
  const plan = await buildCanonicalRefactorPlan({
    operation: "rename",
    doc,
    collection,
    sourceFullPath: join(collection.path, doc.relPath),
    target,
    store: ctx.store,
    sourceEditable: capabilities.editable,
  });

  if (args.action === "preview") {
    return plan;
  }

  const confirmation = requireApplyConfirmation(args);
  // Collection-scoped lock lives inside applyFileRefactor — do not wrap with
  // ctx.writeLockPath (avoids double-locking incompatible with REST/SDK).
  return applyCanonicalFileRefactor({
    plan,
    confirmation,
    deps: buildDurableFileRefactorApplyDeps({
      collection,
      store: ctx.store,
      syncAfterCommit: async () => {
        const syncResult = await defaultSyncService.syncCollection(
          collection,
          ctx.store,
          withContentTypeRules({ runUpdateCmd: false }, ctx.config)
        );
        assertFileRefactorSyncConverged(syncResult);
        recordContentMutation(syncResult, ctx.markContentMutation);
      },
    }),
  });
}

async function previewOrApplyMove(
  args: MoveNoteInput,
  ctx: ToolContext
): Promise<FileRefactorPreviewPlan | FileRefactorApplyResult> {
  requireWriteEnabled(ctx);
  const doc = await resolveDocByRef(ctx, args.ref);
  const capabilities = ensureEditable(doc);
  const collection = resolveCollection(ctx, doc.collection);
  const target = resolveMoveTarget({
    collection: collection.name,
    currentRelPath: doc.relPath,
    folderPath: args.folderPath,
    nextName: args.name,
  });
  const plan = await buildCanonicalRefactorPlan({
    operation: "move",
    doc,
    collection,
    sourceFullPath: join(collection.path, doc.relPath),
    target,
    store: ctx.store,
    sourceEditable: capabilities.editable,
  });

  if (args.action === "preview") {
    return plan;
  }

  const confirmation = requireApplyConfirmation(args);
  return applyCanonicalFileRefactor({
    plan,
    confirmation,
    deps: buildDurableFileRefactorApplyDeps({
      collection,
      store: ctx.store,
      syncAfterCommit: async () => {
        const syncResult = await defaultSyncService.syncCollection(
          collection,
          ctx.store,
          withContentTypeRules({ runUpdateCmd: false }, ctx.config)
        );
        assertFileRefactorSyncConverged(syncResult);
        recordContentMutation(syncResult, ctx.markContentMutation);
      },
    }),
  });
}

export function handleCreateFolder(
  args: CreateFolderInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_create_folder",
    async () => {
      requireWriteEnabled(ctx);

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
    async () => previewOrApplyRename(args, ctx),
    (data) =>
      "planDigest" in data && "canApply" in data
        ? formatPreviewSummary(data)
        : formatApplySummary(data)
  );
}

export function handleMoveNote(
  args: MoveNoteInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_move_note",
    async () => previewOrApplyMove(args, ctx),
    (data) =>
      "planDigest" in data && "canApply" in data
        ? formatPreviewSummary(data)
        : formatApplySummary(data)
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
      requireWriteEnabled(ctx);

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
        // `mkdir -p` follows an existing directory symlink; a copy written
        // through one is unreachable to the indexer, so `plan.nextUri` would
        // name nothing. Prove the chain first.
        try {
          await prepareCaptureDestination(collection.path, plan.nextRelPath);
        } catch (error) {
          if (error instanceof CaptureDestinationError) {
            throw captureDestinationToolError(error);
          }
          throw error;
        }
        await copyFilePath(currentPath, nextPath);
        const syncResult = await defaultSyncService.syncCollection(
          collection,
          ctx.store,
          withContentTypeRules({ runUpdateCmd: false }, ctx.config)
        );
        recordContentMutation(syncResult, ctx.markContentMutation);
        const warnings = buildRefactorWarnings(
          await getRefactorSnapshot(ctx, doc.id)
        ).warnings;
        // A sync that did not error is not proof the copy is indexed - an
        // excluded or unreachable destination is `skipped`, an ordinary
        // non-error. The copy exists on disk, so this is not a tool failure,
        // but `uri` must not silently imply a document that is not there.
        const indexed = await requireActiveCaptureDocument(
          ctx.store,
          collection.name,
          plan.nextRelPath
        );
        if (indexed.ok) {
          // A container copy IS indexed - as N logical records at virtual
          // paths, with nothing at the copy's own path. `uri` below therefore
          // resolves to nothing, exactly like the unindexed case, and must say
          // so rather than read as an ordinary duplicate.
          const containerSummary = captureProofContainerSummary(indexed);
          if (containerSummary) {
            warnings.push(
              `File duplicated on disk and ${containerSummary}, so ${plan.nextUri} resolves to no document.`
            );
          }
          // The copy is imported by the adapter exactly like the original was,
          // so it can be PARTIAL for the same reasons - and the container
          // sentence above says nothing about it. Same shared FRAGMENT every
          // other surface discloses it with - and its default pointer, because this
          // response carries the count and not the failures themselves.
          const partialImport = captureRecordImportReason(
            captureFileSyncResult(syncResult, plan.nextRelPath)?.recordImport
          );
          if (partialImport) {
            warnings.push(partialImport);
          }
        } else {
          warnings.push(
            `File duplicated on disk, but it is not indexed: ${indexed.message}`
          );
        }
        return {
          uri: plan.nextUri,
          relPath: plan.nextRelPath,
          warnings,
        };
      });
    },
    (data) => `Duplicated note to ${data.relPath}`
  );
}
