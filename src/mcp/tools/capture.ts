/**
 * MCP gno_capture tool - create a new document.
 *
 * @module src/mcp/tools/capture
 */

// node:fs/promises for mkdir (no Bun equivalent for structure ops)
import { mkdir } from "node:fs/promises";
// node:path for path utils (no Bun path utils)
import { dirname, extname, join } from "node:path";

import type { NoteCollisionPolicy } from "../../core/note-creation";
import type { NotePresetId } from "../../core/note-presets";
import type { ToolContext } from "../server";

import {
  buildCaptureReceipt,
  CaptureSyncError,
  ensureCapturedFileIndexed,
  listCaptureDiskRelPaths,
  planCapture,
  syncCapturedFile,
  type CaptureInput as SharedCaptureInput,
  type CaptureReceipt,
  type SyncCapturedFileResult,
} from "../../core/capture";
import { writeCapturePlanFile } from "../../core/capture-write";
import { MCP_ERRORS } from "../../core/errors";
import { withWriteLock } from "../../core/file-lock";
import { recordContentMutation } from "../../core/mutation-generations";
import { normalizeCollectionName } from "../../core/validation";
import { DEFAULT_LOCK_WAIT_MS } from "../../core/write-lease";
import { runTool, type ToolResult } from "./index";

interface CaptureInput extends Omit<
  SharedCaptureInput,
  "relPath" | "collisionPolicy" | "presetId"
> {
  path?: string;
  collisionPolicy?: NoteCollisionPolicy;
  presetId?: NotePresetId;
}

type McpCaptureResult = CaptureReceipt & {
  docid: string;
  absPath: string;
  overwritten: boolean;
  serverInstanceId: string;
};

const SENSITIVE_SUBPATHS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".config",
  ".git",
  "node_modules",
]);

function ensureMarkdownExtension(relPath: string): string {
  return extname(relPath) ? relPath : `${relPath}.md`;
}

function assertNotSensitive(relPath: string): void {
  for (const segment of relPath.split(/[\\/]/)) {
    if (segment && SENSITIVE_SUBPATHS.has(segment)) {
      throw new Error(
        `${MCP_ERRORS.INVALID_PATH.code}: Cannot write to sensitive directory: ${segment}`
      );
    }
  }
}

function formatCaptureResult(result: McpCaptureResult): string {
  const lines: string[] = [];
  lines.push(`Doc: ${result.docid}`);
  lines.push(`URI: ${result.uri}`);
  lines.push(`Path: ${result.absPath}`);
  lines.push(`Created: ${result.created ? "yes" : "no"}`);
  lines.push(`Opened existing: ${result.openedExisting ? "yes" : "no"}`);
  lines.push(`Overwritten: ${result.overwritten ? "yes" : "no"}`);
  lines.push(`Collision: ${result.collisionPolicyResult}`);
  lines.push(`Sync: ${result.sync.status}`);
  lines.push(`Embed: ${result.embed.status}`);
  lines.push(`Content hash: ${result.contentHash}`);
  if (result.tags.length > 0) {
    lines.push(`Tags: ${result.tags.join(", ")}`);
  }
  return lines.join("\n");
}

function buildSharedInput(
  args: CaptureInput,
  collectionName: string
): SharedCaptureInput {
  return {
    collection: collectionName,
    content: args.content,
    title: args.title,
    relPath: args.path ? ensureMarkdownExtension(args.path) : undefined,
    folderPath: args.folderPath,
    collisionPolicy: args.collisionPolicy,
    presetId: args.presetId,
    tags: args.tags,
    source: args.source,
    overwrite: args.overwrite,
  };
}

/** Surface a sync failure as an MCP tool error the `CODE: message` way. */
function rethrowCaptureError(error: unknown): never {
  if (error instanceof CaptureSyncError) {
    throw new Error(`${error.code}: ${error.message}`);
  }
  throw error;
}

export function handleCapture(
  args: CaptureInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_capture",
    async () => {
      if (!ctx.enableWrite) {
        throw new Error("Write tools disabled. Start MCP with --enable-write.");
      }

      const collectionName = normalizeCollectionName(args.collection);
      const collection = ctx.collections.find(
        (c) => c.name.toLowerCase() === collectionName
      );
      if (!collection) {
        throw new Error(
          `${MCP_ERRORS.NOT_FOUND.code}: Collection not found: ${args.collection}`
        );
      }

      // Write + lexical sync complete under the shared write lease: the tool
      // succeeds only once the capture is retrievable (v1.38 contention
      // contract: wait for the lease, LOCKED when it stays busy).
      return await withWriteLock(
        ctx.writeLockPath,
        async () => {
          const existingDocs = await ctx.store.listDocuments(collectionName);
          if (!existingDocs.ok) {
            throw new Error(existingDocs.error.message);
          }

          let plan;
          try {
            plan = planCapture({
              input: buildSharedInput(args, collection.name),
              existingRelPaths: existingDocs.value.map((doc) => doc.relPath),
              diskRelPaths: await listCaptureDiskRelPaths(collection.path),
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            throw new Error(`${MCP_ERRORS.INVALID_INPUT.code}: ${message}`);
          }

          assertNotSensitive(plan.relPath);

          const absPath = join(collection.path, plan.relPath);
          const syncInput = {
            collection,
            store: ctx.store,
            relPath: plan.relPath,
            absPath,
            config: ctx.config,
          };

          let synced: SyncCapturedFileResult;
          let overwritten = false;
          try {
            if (plan.openedExisting) {
              synced = await ensureCapturedFileIndexed(syncInput);
            } else {
              overwritten =
                (await Bun.file(absPath).exists()) && args.overwrite === true;
              await mkdir(dirname(absPath), { recursive: true });
              await writeCapturePlanFile(plan, absPath);
              synced = await syncCapturedFile(syncInput);
            }
          } catch (error) {
            rethrowCaptureError(error);
          }
          if (synced.result) {
            recordContentMutation(synced.result, ctx.markContentMutation);
          }

          const isMarkdown =
            plan.relPath.endsWith(".md") || plan.relPath.endsWith(".markdown");
          if (!isMarkdown && !plan.openedExisting && plan.tags.length > 0) {
            const tagResult = await ctx.store.setDocTags(
              synced.documentId,
              plan.tags,
              "user"
            );
            if (!tagResult.ok) {
              console.error(
                `[MCP] Warning: Document created but tags not stored: ${tagResult.error.message}`
              );
            }
          }

          return buildCaptureReceipt({
            plan,
            absPath,
            docid: synced.docid,
            sync: synced.sync,
            overwritten,
            serverInstanceId: ctx.serverInstanceId,
          }) as McpCaptureResult;
        },
        DEFAULT_LOCK_WAIT_MS
      );
    },
    formatCaptureResult
  );
}
