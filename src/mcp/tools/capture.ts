/**
 * MCP gno_capture tool - create a new document.
 *
 * @module src/mcp/tools/capture
 */

// node:fs/promises for mkdir (no Bun equivalent for structure ops)
import { mkdir } from "node:fs/promises";
// node:path for path utils (no Bun path utils)
import { dirname, extname, join } from "node:path";

import type { ToolContext } from "../server";

import { buildUri } from "../../app/constants";
import { MCP_ERRORS } from "../../core/errors";
import { withWriteLock } from "../../core/file-lock";
import { atomicWrite } from "../../core/file-ops";
import {
  normalizeCollectionName,
  validateRelPath,
} from "../../core/validation";
import { defaultSyncService } from "../../ingestion";
import { extractTitle } from "../../pipeline/contextual";
import { runTool, type ToolResult } from "./index";

interface CaptureInput {
  collection: string;
  content: string;
  title?: string;
  path?: string;
  overwrite?: boolean;
}

interface CaptureResult {
  docid: string;
  uri: string;
  absPath: string;
  collection: string;
  relPath: string;
  created: boolean;
  overwritten: boolean;
  serverInstanceId: string;
}

const SENSITIVE_SUBPATHS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".config",
  ".git",
  "node_modules",
]);

function sanitizeFilename(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replaceAll(/[^\w\s-]/g, "")
    .replaceAll(/\s+/g, "-")
    .replaceAll(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

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

function generateFilename(title: string | undefined, content: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fallback = `note-${timestamp}.md`;
  const baseTitle = title?.trim() || extractTitle(content, fallback);
  const slug = sanitizeFilename(baseTitle);
  const safeSlug = slug || `note-${timestamp}`;
  return `${safeSlug}.md`;
}

function formatCaptureResult(result: CaptureResult): string {
  const lines: string[] = [];
  lines.push(`Doc: ${result.docid}`);
  lines.push(`URI: ${result.uri}`);
  lines.push(`Path: ${result.absPath}`);
  lines.push(`Created: ${result.created ? "yes" : "no"}`);
  lines.push(`Overwritten: ${result.overwritten ? "yes" : "no"}`);
  return lines.join("\n");
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

        let relPath: string;
        if (args.path) {
          try {
            relPath = ensureMarkdownExtension(validateRelPath(args.path));
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            throw new Error(`${MCP_ERRORS.INVALID_PATH.code}: ${message}`);
          }
        } else {
          relPath = generateFilename(args.title, args.content);
        }

        assertNotSensitive(relPath);

        const absPath = join(collection.path, relPath);
        const file = Bun.file(absPath);
        const exists = await file.exists();
        if (exists && !args.overwrite) {
          throw new Error(
            `${MCP_ERRORS.CONFLICT.code}: File exists: ${relPath}`
          );
        }

        await mkdir(dirname(absPath), { recursive: true });
        await atomicWrite(absPath, args.content);

        const results = await defaultSyncService.syncFiles(
          collection,
          ctx.store,
          [relPath],
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
        if (!docid) {
          const docResult = await ctx.store.getDocument(
            collectionName,
            relPath
          );
          if (!docResult.ok) {
            throw new Error(docResult.error.message);
          }
          if (!docResult.value) {
            throw new Error("RUNTIME: Document missing after sync");
          }
          docid = docResult.value.docid;
        }

        return {
          docid,
          uri: buildUri(collectionName, relPath),
          absPath,
          collection: collectionName,
          relPath,
          created: !exists,
          overwritten: exists,
          serverInstanceId: ctx.serverInstanceId,
        };
      });
    },
    formatCaptureResult
  );
}
