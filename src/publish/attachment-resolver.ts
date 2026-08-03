/**
 * Parser-aware local attachment discovery, rewrite, and v1 bundling entrypoints.
 *
 * @module src/publish/attachment-resolver
 */

import type {
  AttachmentDiagnostic,
  AttachmentResolveContext,
  PendingAssetPayload,
} from "./attachment-types";

import {
  GNO_ASSET_SENTINEL_PREFIX,
  MAX_PUBLISH_UPLOAD_BYTES,
} from "./artifact-asset-contract";
import { formatGnoAssetSentinel } from "./artifact-asset-sniff";
import {
  attachAssetsToV1Artifact,
  buildDeterministicAssets,
  emptyAssetEgressSummary,
  summarizeAssetEgress,
} from "./attachment-bundle";
import {
  discoverImageOccurrences,
  type DiscoveredImageRef,
} from "./attachment-discover";
import { readAndValidateAsset } from "./attachment-load";
import {
  assertContainedFile,
  buildAttachmentBasenameIndex,
  diagnostic,
  resolveCandidateRelPath,
} from "./attachment-path";

export type {
  AttachmentDiagnostic,
  AttachmentDiagnosticCode,
  AttachmentResolveContext,
  PendingAssetPayload,
  PublishAssetEgressSummary,
} from "./attachment-types";
export {
  attachAssetsToV1Artifact,
  buildDeterministicAssets,
  emptyAssetEgressSummary,
  summarizeAssetEgress,
} from "./attachment-bundle";
export { buildAttachmentBasenameIndex } from "./attachment-path";

export interface AttachmentRewriteResult {
  diagnostics: AttachmentDiagnostic[];
  externalCount: number;
  markdown: string;
  payloads: Map<string, PendingAssetPayload>;
  /** Raw bytes summed per successful load before cross-ref dedup. */
  preDedupRawBytes: number;
}

type ImageOccurrence = DiscoveredImageRef;

const isExternalDestination = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(trimmed);
};

const isDataUrl = (value: string): boolean =>
  value.trim().toLowerCase().startsWith("data:");

const escapeMarkdownImageAlt = (value: string): string =>
  value.replace(/[\\[\]]/gu, "\\$&");

const formatMarkdownImageTitle = (value: string | null | undefined): string =>
  value === null || value === undefined
    ? ""
    : ` "${value.replace(/[\\"]/gu, "\\$&")}"`;

const rewriteOccurrence = (
  occurrence: ImageOccurrence,
  assetId: string
): string => {
  const sentinel = formatGnoAssetSentinel(assetId);
  if (occurrence.kind === "markdown") {
    return `![${escapeMarkdownImageAlt(occurrence.alt)}](${sentinel}${formatMarkdownImageTitle(occurrence.title)})`;
  }
  const alias = occurrence.alt.trim();
  const display = alias.length > 0 && !/^\d+$/u.test(alias) ? alias : "";
  return `![${display}](${sentinel})`;
};

const mergePayload = (
  payloads: Map<string, PendingAssetPayload>,
  loaded: PendingAssetPayload,
  noteSlug: string,
  relPath: string
): void => {
  const existing = payloads.get(loaded.sha256);
  if (existing) {
    existing.references.push({ noteSlug, sourceRef: relPath });
    return;
  }
  payloads.set(loaded.sha256, loaded);
};

/**
 * Discover local/external image refs in one parser-aware pass and rewrite
 * successfully bundled destinations to gno-asset:<sha256>.
 */
export async function rewriteAttachmentsInMarkdown(
  markdown: string,
  ctx: AttachmentResolveContext
): Promise<AttachmentRewriteResult> {
  const occurrences = discoverImageOccurrences(markdown);
  const diagnostics: AttachmentDiagnostic[] = [];
  const payloads = new Map<string, PendingAssetPayload>();
  let externalCount = 0;
  let newEncodedAssetBytes = 0;
  let preDedupRawBytes = 0;
  const replacements: Array<{ end: number; start: number; text: string }> = [];

  for (const occurrence of occurrences) {
    const ref = occurrence.sourceRef.trim();
    if (!ref) {
      diagnostics.push(
        diagnostic(
          "ASSET_CORRUPT",
          "Empty image destination",
          ctx.noteSlug,
          ref
        )
      );
      replacements.push({
        start: occurrence.start,
        end: occurrence.end,
        text: "",
      });
      continue;
    }
    if (isDataUrl(ref)) {
      diagnostics.push(
        diagnostic(
          "ASSET_UNSUPPORTED_FORMAT",
          "data: image URLs are unsupported",
          ctx.noteSlug,
          ref
        )
      );
      replacements.push({
        start: occurrence.start,
        end: occurrence.end,
        text: "",
      });
      continue;
    }
    if (ref.startsWith(GNO_ASSET_SENTINEL_PREFIX)) {
      diagnostics.push(
        diagnostic(
          "ASSET_CORRUPT",
          "Authored gno-asset references are reserved for publish export",
          ctx.noteSlug,
          ref
        )
      );
      replacements.push({
        start: occurrence.start,
        end: occurrence.end,
        text: "",
      });
      continue;
    }
    if (isExternalDestination(ref)) {
      if (/^https?:/iu.test(ref) || ref.startsWith("//")) {
        externalCount += 1;
        continue;
      }
      diagnostics.push(
        diagnostic(
          "ASSET_UNSUPPORTED_FORMAT",
          `Unsupported image protocol in "${ref}"`,
          ctx.noteSlug,
          ref
        )
      );
      replacements.push({
        start: occurrence.start,
        end: occurrence.end,
        text: "",
      });
      continue;
    }
    const resolved = resolveCandidateRelPath(ref, ctx, occurrence.kind);
    if (!resolved.ok) {
      if (resolved.diagnostic.code === "ASSET_TRAVERSAL") {
        throw new Error(
          `ASSET_TRAVERSAL: ${resolved.diagnostic.message} (${ref})`
        );
      }
      diagnostics.push(resolved.diagnostic);
      replacements.push({
        start: occurrence.start,
        end: occurrence.end,
        text: "",
      });
      continue;
    }

    const contained = await assertContainedFile(
      ctx.collectionRoot,
      resolved.relPath,
      ctx.noteSlug,
      ref,
      ctx.collectionExcludes
    );
    if ("code" in contained) {
      diagnostics.push(contained);
      replacements.push({
        start: occurrence.start,
        end: occurrence.end,
        text: "",
      });
      continue;
    }

    const loaded = await readAndValidateAsset(
      contained.absPath,
      ctx.noteSlug,
      ref,
      resolved.relPath
    );
    if ("code" in loaded) {
      diagnostics.push(loaded);
      replacements.push({
        start: occurrence.start,
        end: occurrence.end,
        text: "",
      });
      continue;
    }

    preDedupRawBytes += loaded.byteLength;
    const isNewAsset =
      !payloads.has(loaded.sha256) && !ctx.existingAssetIds?.has(loaded.sha256);
    if (isNewAsset) {
      const projectedEncodedBytes =
        (ctx.existingEncodedAssetBytes ?? 0) +
        newEncodedAssetBytes +
        loaded.data.length;
      if (projectedEncodedBytes > MAX_PUBLISH_UPLOAD_BYTES) {
        throw new Error(
          `ENVELOPE_OVERSIZE: encoded asset data exceeds ${MAX_PUBLISH_UPLOAD_BYTES} bytes`
        );
      }
      newEncodedAssetBytes += loaded.data.length;
    }
    mergePayload(payloads, loaded, ctx.noteSlug, resolved.relPath);
    replacements.push({
      start: occurrence.start,
      end: occurrence.end,
      text: rewriteOccurrence(occurrence, loaded.sha256),
    });
  }

  let output = markdown;
  for (const replacement of [...replacements].sort(
    (a, b) => b.start - a.start
  )) {
    output =
      output.slice(0, replacement.start) +
      replacement.text +
      output.slice(replacement.end);
  }

  return {
    diagnostics,
    externalCount,
    markdown: output,
    payloads,
    preDedupRawBytes,
  };
}
