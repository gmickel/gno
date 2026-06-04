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
  listCaptureDiskRelPaths,
  planCapture,
  type CaptureInput as SharedCaptureInput,
  type CaptureReceipt,
} from "../../core/capture";
import { MCP_ERRORS } from "../../core/errors";
import { withWriteLock } from "../../core/file-lock";
import { atomicWrite } from "../../core/file-ops";
import { normalizeCollectionName } from "../../core/validation";
import { defaultSyncService } from "../../ingestion";
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
  const firstSegment = relPath.split(/[\\/]/)[0];
  if (firstSegment && SENSITIVE_SUBPATHS.has(firstSegment)) {
    throw new Error(
      `${MCP_ERRORS.INVALID_PATH.code}: Cannot write to sensitive directory: ${firstSegment}`
    );
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

      return await withWriteLock(ctx.writeLockPath, async () => {
        const collectionName = normalizeCollectionName(args.collection);
        const collection = ctx.collections.find(
          (c) => c.name.toLowerCase() === collectionName
        );
        if (!collection) {
          throw new Error(
            `${MCP_ERRORS.NOT_FOUND.code}: Collection not found: ${args.collection}`
          );
        }

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
        const existingFile = Bun.file(absPath);
        const exists = await existingFile.exists();

        if (plan.openedExisting) {
          const docResult = await ctx.store.getDocument(
            collectionName,
            plan.relPath
          );
          const existingDoc = docResult.ok ? docResult.value : undefined;
          return buildCaptureReceipt({
            plan,
            absPath,
            docid: existingDoc?.docid ?? "",
            sync: {
              status: existingDoc ? "completed" : "skipped",
              reason: existingDoc
                ? "Existing capture already indexed."
                : "Existing capture opened from disk but is not indexed yet.",
            },
            serverInstanceId: ctx.serverInstanceId,
          }) as McpCaptureResult;
        }

        await mkdir(dirname(absPath), { recursive: true });
        await atomicWrite(absPath, plan.content);

        const results = await defaultSyncService.syncFiles(
          collection,
          ctx.store,
          [plan.relPath],
          { runUpdateCmd: false, gitPull: false }
        );
        const syncResult = results[0];
        if (!syncResult) {
          throw new Error("RUNTIME: Sync result missing");
        }
        if (syncResult.status === "error") {
          throw new Error(
            `INGEST_ERROR: ${syncResult.errorCode ?? "ERROR"} - ${
              syncResult.errorMessage ?? "Unknown error"
            }`
          );
        }

        let docid = syncResult.docid;
        let documentId: number | undefined;
        const docResult = await ctx.store.getDocument(
          collectionName,
          plan.relPath
        );
        if (docResult.ok && docResult.value) {
          docid = docid ?? docResult.value.docid;
          documentId = docResult.value.id;
        }
        if (!docid) {
          throw new Error("RUNTIME: Document missing after sync");
        }

        const isMarkdown =
          plan.relPath.endsWith(".md") || plan.relPath.endsWith(".markdown");
        if (!isMarkdown && plan.tags.length > 0 && documentId) {
          const tagResult = await ctx.store.setDocTags(
            documentId,
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
          docid,
          sync: { status: "completed" },
          overwritten: exists && args.overwrite === true,
          serverInstanceId: ctx.serverInstanceId,
        }) as McpCaptureResult;
      });
    },
    formatCaptureResult
  );
}
