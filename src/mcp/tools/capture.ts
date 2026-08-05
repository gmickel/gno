/**
 * MCP gno_capture tool - create a new document.
 *
 * @module src/mcp/tools/capture
 */

// node:path for path utils (no Bun path utils)
import { extname, join } from "node:path";

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
import { writeCapturePlanFile } from "../../core/capture-write";
import { MCP_ERRORS } from "../../core/errors";
import { withWriteLock } from "../../core/file-lock";
import { normalizeCollectionName } from "../../core/validation";
import {
  CaptureDestinationError,
  captureProofDocid,
  captureProofOpenedExistingSyncReason,
  captureSyncReason,
  defaultSyncService,
  prepareCaptureDestination,
  requireActiveCaptureDocument,
  withContentTypeRules,
} from "../../ingestion";
import { captureDestinationToolError, runTool, type ToolResult } from "./index";

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
  // The JSON result must carry `docid` (the schema requires it) and uses the
  // empty string for "not resolved". The TEXT an agent reads must not print
  // `Doc:` with nothing after it - `sync.reason` below says what happened.
  if (result.docid) {
    lines.push(`Doc: ${result.docid}`);
  }
  lines.push(`URI: ${result.uri}`);
  lines.push(`Path: ${result.absPath}`);
  lines.push(`Created: ${result.created ? "yes" : "no"}`);
  lines.push(`Opened existing: ${result.openedExisting ? "yes" : "no"}`);
  lines.push(`Overwritten: ${result.overwritten ? "yes" : "no"}`);
  lines.push(`Collision: ${result.collisionPolicyResult}`);
  lines.push(`Sync: ${result.sync.status}`);
  if (result.sync.reason) {
    lines.push(`Note: ${result.sync.reason}`);
  }
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
          // "Is this file indexed?" is asked here exactly as the post-write
          // proof asks it: by EFFECTIVE SOURCE PATH. A bare `getDocument`
          // answers "no" for a record container that is fully indexed as N
          // logical records at virtual paths, so an opened container was
          // reported as unindexed.
          const indexed = await requireActiveCaptureDocument(
            ctx.store,
            collectionName,
            plan.relPath
          );
          // A store failure is not "not indexed yet" — it is an unknown
          // answer, and reporting it as a calm non-error receipt would hide
          // an outage behind a normal-looking result. Same guard as the CLI,
          // SDK and REST capture paths.
          if (!indexed.ok && indexed.failure === "store-error") {
            throw new Error(indexed.message);
          }
          return buildCaptureReceipt({
            plan,
            absPath,
            // `docid` is schema-required; a container has none of its own, so
            // it reports the empty string this tool already uses for "not
            // resolved" rather than one of its N record docids.
            docid: (indexed.ok ? captureProofDocid(indexed) : undefined) ?? "",
            sync: indexed.ok
              ? {
                  status: "completed",
                  reason:
                    captureProofOpenedExistingSyncReason(indexed) ??
                    "Existing capture already indexed.",
                }
              : {
                  status: "skipped",
                  reason:
                    "Existing capture opened from disk but is not indexed yet.",
                },
            serverInstanceId: ctx.serverInstanceId,
          }) as McpCaptureResult;
        }

        // Prove the destination BEFORE writing: `mkdir -p` follows an existing
        // directory symlink, and a file written through one is unreachable to
        // the indexer (or outside the collection, for an escaping alias).
        try {
          await prepareCaptureDestination(collection.path, plan.relPath);
        } catch (error) {
          if (error instanceof CaptureDestinationError) {
            throw captureDestinationToolError(error);
          }
          throw error;
        }
        await writeCapturePlanFile(plan, absPath);

        const results = await defaultSyncService.syncFiles(
          collection,
          ctx.store,
          [plan.relPath],
          withContentTypeRules(
            { runUpdateCmd: false, gitPull: false },
            ctx.config
          )
        );
        const syncResult = results[0];
        if (!syncResult) {
          return buildCaptureReceipt({
            plan,
            absPath,
            docid: "",
            sync: {
              status: "failed",
              error: "RUNTIME: Sync result missing",
            },
            overwritten: exists && args.overwrite === true,
            serverInstanceId: ctx.serverInstanceId,
          }) as McpCaptureResult;
        }
        if (syncResult.status === "error") {
          return buildCaptureReceipt({
            plan,
            absPath,
            docid: "",
            sync: {
              status: "failed",
              error: `INGEST_ERROR: ${syncResult.errorCode ?? "ERROR"} - ${
                syncResult.errorMessage ?? "Unknown error"
              }`,
            },
            overwritten: exists && args.overwrite === true,
            serverInstanceId: ctx.serverInstanceId,
          }) as McpCaptureResult;
        }
        if (syncResult.status === "added" || syncResult.status === "updated") {
          ctx.markContentMutation?.();
        }

        // "Not an error" is not proof of a capture: `skipped` and `unchanged`
        // are non-errors too. Demand an ACTIVE document for the path.
        const indexed = await requireActiveCaptureDocument(
          ctx.store,
          collectionName,
          plan.relPath
        );
        if (!indexed.ok) {
          return buildCaptureReceipt({
            plan,
            absPath,
            docid: "",
            sync: {
              status: "failed",
              error: `RUNTIME: Document missing after sync - ${indexed.message}`,
            },
            overwritten: exists && args.overwrite === true,
            serverInstanceId: ctx.serverInstanceId,
          }) as McpCaptureResult;
        }
        // `docid` is required by the gno_capture result schema, so a record
        // container - which has no document at the written path - reports the
        // empty string this tool already uses for "not resolved", never one of
        // its N record docids, which would disagree with the receipt URI.
        const docid = syncResult.docid ?? captureProofDocid(indexed) ?? "";

        const isMarkdown =
          plan.relPath.endsWith(".md") || plan.relPath.endsWith(".markdown");
        if (!isMarkdown && plan.tags.length > 0) {
          // Non-Markdown tags live in the index, not in frontmatter. For a
          // record container the capture's tags describe the whole written
          // file, so they go on every logical record it produced - tagging one
          // arbitrary record would be both incomplete and unpredictable.
          const targets =
            indexed.kind === "file"
              ? [indexed.document.id]
              : indexed.records.map((row) => row.id);
          for (const target of targets) {
            const tagResult = await ctx.store.setDocTags(
              target,
              plan.tags,
              "user"
            );
            if (!tagResult.ok) {
              console.error(
                `[MCP] Warning: Document created but tags not stored: ${tagResult.error.message}`
              );
            }
          }
        }

        return buildCaptureReceipt({
          plan,
          absPath,
          docid,
          sync: {
            status: "completed",
            reason: captureSyncReason(indexed, syncResult.recordImport),
          },
          overwritten: exists && args.overwrite === true,
          serverInstanceId: ctx.serverInstanceId,
        }) as McpCaptureResult;
      });
    },
    formatCaptureResult
  );
}
