/**
 * gno capture command implementation.
 *
 * @module src/cli/commands/capture
 */

import type {
  CaptureInput,
  CaptureReceipt,
  CaptureSourceKind,
} from "../../core/capture";
import type { NoteCollisionPolicy } from "../../core/note-creation";
import type { NotePresetId } from "../../core/note-presets";
import type { RequestReceiptInfo } from "../../core/request-receipts";

import { getIndexDbPath } from "../../app/constants";
import {
  listCaptureDiskRelPaths,
  planCapture,
  serializeCaptureReceipt,
} from "../../core/capture";
import { publishCapture } from "../../core/capture-publish";
import {
  LOCAL_OWNER_NAMESPACE,
  requestLedgerPath,
} from "../../core/request-receipts";
import { writeLeasePath } from "../../core/write-lease";
import { CliError } from "../errors";
import { requestErrorToCli } from "./request-status";
import { initStore } from "./shared";

export interface CaptureCliOptions {
  configPath?: string;
  indexName?: string;
  inlineContent?: string;
  stdin?: boolean;
  file?: string;
  collection?: string;
  title?: string;
  path?: string;
  folder?: string;
  preset?: NotePresetId;
  tags?: string;
  collisionPolicy?: NoteCollisionPolicy;
  sourceKind?: CaptureSourceKind;
  sourceUrl?: string;
  sourceTitle?: string;
  sourceAuthor?: string;
  sourceDate?: string;
  sourceId?: string;
  requestId?: string;
}

const SOURCE_KINDS = new Set<CaptureSourceKind>([
  "direct",
  "web",
  "email",
  "meeting",
  "chat",
  "file",
  "api",
  "unknown",
]);
const COLLISION_POLICIES = new Set<NoteCollisionPolicy>([
  "error",
  "open_existing",
  "create_with_suffix",
]);

function parseTags(raw: string | undefined): string[] {
  return (
    raw
      ?.split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0) ?? []
  );
}

async function readContent(
  options: CaptureCliOptions
): Promise<string | undefined> {
  const sources = [
    options.inlineContent?.trim().length ? "inline" : null,
    options.stdin ? "stdin" : null,
    options.file ? "file" : null,
  ].filter((source) => source !== null);
  if (sources.length > 1) {
    throw new CliError(
      "VALIDATION",
      "Use only one content source: inline, --stdin, or --file."
    );
  }

  if (options.stdin) {
    return await Bun.stdin.text();
  }
  if (options.file) {
    return await Bun.file(options.file).text();
  }
  return options.inlineContent;
}

function buildSource(options: CaptureCliOptions) {
  if (options.sourceKind && !SOURCE_KINDS.has(options.sourceKind)) {
    throw new CliError(
      "VALIDATION",
      "--source-kind must be one of: direct, web, email, meeting, chat, file, api, unknown"
    );
  }
  return {
    kind: options.sourceKind,
    url: options.sourceUrl,
    title: options.sourceTitle,
    author: options.sourceAuthor,
    observedAt: options.sourceDate,
    externalId: options.sourceId,
  };
}

function validateCollisionPolicy(
  policy: NoteCollisionPolicy | undefined
): void {
  if (policy && !COLLISION_POLICIES.has(policy)) {
    throw new CliError(
      "VALIDATION",
      "--collision-policy must be one of: error, open_existing, create_with_suffix"
    );
  }
}

export async function capture(
  options: CaptureCliOptions
): Promise<CaptureReceipt & { request?: RequestReceiptInfo }> {
  const storeInit = await initStore({
    configPath: options.configPath,
    indexName: options.indexName,
    syncConfig: true,
  });
  if (!storeInit.ok) {
    throw new CliError("VALIDATION", storeInit.error);
  }

  const { store, collections, config } = storeInit;
  try {
    const collectionName = options.collection?.trim();
    const collection = collectionName
      ? collections.find(
          (candidate) =>
            candidate.name.toLowerCase() === collectionName.toLowerCase()
        )
      : collections[0];
    if (!collection) {
      throw new CliError(
        "VALIDATION",
        collectionName
          ? `Collection not found: ${collectionName}`
          : "No editable collection configured."
      );
    }

    validateCollisionPolicy(options.collisionPolicy);
    const content = await readContent(options);
    const input: CaptureInput = {
      collection: collection.name,
      content,
      title: options.title,
      relPath: options.path,
      folderPath: options.folder,
      collisionPolicy: options.collisionPolicy,
      presetId: options.preset,
      tags: parseTags(options.tags),
      source: buildSource(options),
    };
    const dbPath = getIndexDbPath(options.indexName);
    try {
      const published = await publishCapture({
        collection,
        store,
        lockPath: writeLeasePath(dbPath),
        config,
        plan: async () => {
          const existingDocs = await store.listDocuments(collection.name);
          if (!existingDocs.ok) {
            throw new Error(existingDocs.error.message);
          }
          try {
            return planCapture({
              input,
              existingRelPaths: existingDocs.value.map((doc) => doc.relPath),
              diskRelPaths: await listCaptureDiskRelPaths(collection.path),
            });
          } catch (error) {
            throw new CliError(
              "VALIDATION",
              error instanceof Error ? error.message : String(error)
            );
          }
        },
        request:
          options.requestId === undefined
            ? undefined
            : {
                ledgerPath: requestLedgerPath(dbPath),
                namespace: LOCAL_OWNER_NAMESPACE,
                requestId: options.requestId,
                input,
              },
      });
      return published.request
        ? { ...published.receipt, request: published.request }
        : published.receipt;
    } catch (error) {
      throw requestErrorToCli(error);
    }
  } finally {
    await store.close();
  }
}

export function formatCaptureReceipt(
  receipt: CaptureReceipt & { request?: RequestReceiptInfo },
  options: { json?: boolean; quiet?: boolean } = {}
): string {
  if (options.json) {
    return serializeCaptureReceipt(receipt);
  }
  if (options.quiet) {
    return receipt.uri;
  }

  const lines = [
    receipt.openedExisting ? "Opened existing capture." : "Captured note.",
    `URI: ${receipt.uri}`,
    `Path: ${receipt.absPath ?? receipt.relPath}`,
    `Sync: ${receipt.sync.status}`,
    `Embed: ${receipt.embed.status}`,
  ];
  if (receipt.tags.length > 0) {
    lines.push(`Tags: ${receipt.tags.join(", ")}`);
  }
  if (receipt.source.url) {
    lines.push(`Source: ${receipt.source.url}`);
  }
  if (receipt.request) {
    lines.push(
      `Request: ${receipt.request.requestId} committed${receipt.request.replayed ? " (replayed, nothing written again)" : ""}`
    );
  }
  return lines.join("\n");
}
