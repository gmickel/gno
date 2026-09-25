/**
 * MCP gno_capture tool - create a new document.
 *
 * @module src/mcp/tools/capture
 */

// node:path for path utils (no Bun path utils)
import { extname } from "node:path";

import type { NoteCollisionPolicy } from "../../core/note-creation";
import type { NotePresetId } from "../../core/note-presets";
import type { ToolContext } from "../server";

import {
  CaptureSyncError,
  listCaptureDiskRelPaths,
  planCapture,
  type CaptureInput as SharedCaptureInput,
  type CapturePlan,
  type CaptureReceipt,
} from "../../core/capture";
import {
  publishCapture,
  type PublishedCapture,
} from "../../core/capture-publish";
import { MCP_ERRORS } from "../../core/errors";
import { recordContentMutation } from "../../core/mutation-generations";
import {
  formatRequestReceiptLine,
  type RequestReceiptInfo,
  requestLedgerPath,
} from "../../core/request-receipts";
import { normalizeCollectionName } from "../../core/validation";
import { DEFAULT_LOCK_WAIT_MS } from "../../core/write-lease";
import { runTool, type ToolResult } from "./index";
import { mcpRequestNamespace, rethrowRequestError } from "./request-status";

interface CaptureInput extends Omit<
  SharedCaptureInput,
  "relPath" | "collisionPolicy" | "presetId"
> {
  path?: string;
  collisionPolicy?: NoteCollisionPolicy;
  presetId?: NotePresetId;
  requestId?: string;
}

type McpCaptureResult = CaptureReceipt & {
  docid: string;
  absPath: string;
  overwritten: boolean;
  serverInstanceId: string;
  request?: RequestReceiptInfo;
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
  if (result.request) lines.push(formatRequestReceiptLine(result.request));
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
  return rethrowRequestError(error);
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
      const input = buildSharedInput(args, collection.name);
      let published: PublishedCapture;
      try {
        published = await publishCapture({
          collection,
          store: ctx.store,
          lockPath: ctx.writeLockPath,
          lockWaitMs: DEFAULT_LOCK_WAIT_MS,
          config: ctx.config,
          plan: async () => {
            const existingDocs = await ctx.store.listDocuments(collectionName);
            if (!existingDocs.ok) {
              throw new Error(existingDocs.error.message);
            }
            let plan: CapturePlan;
            try {
              plan = planCapture({
                input,
                existingRelPaths: existingDocs.value.map((doc) => doc.relPath),
                diskRelPaths: await listCaptureDiskRelPaths(collection.path),
              });
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              throw new Error(`${MCP_ERRORS.INVALID_INPUT.code}: ${message}`);
            }
            assertNotSensitive(plan.relPath);
            return plan;
          },
          afterSync: async (synced, receipt) => {
            if (synced.result) {
              recordContentMutation(synced.result, ctx.markContentMutation);
            }
            const isMarkdown =
              receipt.relPath.endsWith(".md") ||
              receipt.relPath.endsWith(".markdown");
            if (
              !isMarkdown &&
              !receipt.openedExisting &&
              receipt.tags.length > 0
            ) {
              const tagResult = await ctx.store.setDocTags(
                synced.documentId,
                receipt.tags,
                "user"
              );
              if (!tagResult.ok) {
                console.error(
                  `[MCP] Warning: Document created but tags not stored: ${tagResult.error.message}`
                );
              }
            }
          },
          request:
            args.requestId === undefined
              ? undefined
              : {
                  ledgerPath: requestLedgerPath(ctx.store.getDbPath()),
                  namespace: mcpRequestNamespace(ctx),
                  requestId: args.requestId,
                  input,
                },
        });
      } catch (error) {
        rethrowCaptureError(error);
      }

      return {
        ...published.receipt,
        docid: published.receipt.docid ?? "",
        absPath: published.receipt.absPath ?? "",
        overwritten: published.receipt.overwritten ?? false,
        serverInstanceId: ctx.serverInstanceId,
        ...(published.request ? { request: published.request } : {}),
      } as McpCaptureResult;
    },
    formatCaptureResult
  );
}
