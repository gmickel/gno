/**
 * Per-file preparation: everything CPU-bound between a file's bytes and its
 * database write (fn-198).
 *
 * Conversion, metadata, tags, memory scopes, code regions, change-journal
 * structure (previous and next), chunking and link parsing run here as one
 * step. Sync runs it in the terminable file worker, so a file that overruns
 * its budget is stopped mid-step; where no worker can start (a compiled
 * executable, or injected test doubles) it runs in-process and the budget is
 * checked between steps. The main thread keeps every database read and write.
 *
 * @module src/ingestion/prepare-file
 */

import type { NormalizedContentTypeRule } from "../config";
import type {
  ConversionArtifact,
  ConvertInput,
  PipelineResult,
} from "../converters/types";
import type { DocumentStructureSnapshot } from "../core/change-diff";
import type { ChunkInput, DocLinkInput } from "../store/types";
import type { DocumentMetadata } from "./document-metadata";
import type { ChunkerPort, ChunkParams } from "./types";

import { MARKDOWN_CONVERTER_ID } from "../converters/native/markdown";
import { extractDocumentStructure } from "../core/change-diff";
import {
  normalizeMarkdownPath,
  normalizeWikiName,
  parseLinks,
} from "../core/links";
import { extractMemoryScopes } from "../core/memory-record";
import { extractDocumentMetadata, extractTags } from "./document-metadata";
import { buildLineOffsets } from "./position";
import { type ExcludedRange, getExcludedRanges } from "./strip";

/** The previously indexed revision, for the change journal. */
export interface PreviousRevision {
  markdown: string;
  relPath: string;
  dateFields: Record<string, string> | null;
  converterId: string | null;
}

export interface PrepareFileRequest {
  input: ConvertInput;
  /** Extension used for path-based content-type inference. */
  metadataExt: string;
  contentTypeRules: NormalizedContentTypeRule[];
  chunkParams: ChunkParams;
  collectionLanguageHint?: string;
  memoryManaged: boolean;
  /**
   * Whether this file is a Markdown source (the Markdown converter handles
   * it). The previous revision's links are read under this rule too, so a
   * non-Markdown source never journals link additions or removals.
   */
  markdownSource: boolean;
  previous: PreviousRevision | null;
}

export interface PreparedFile {
  artifact: ConversionArtifact;
  metadata: DocumentMetadata;
  nextStructure: DocumentStructureSnapshot;
  chunkInputs: ChunkInput[];
  linkInputs: DocLinkInput[];
  tags: string[];
  /** Managed-memory scopes; null outside memory-managed collections. */
  memoryScopes: string[] | null;
}

/** Why a file was not prepared: a conversion error or a budget overrun. */
export interface PrepareFailure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type PrepareOutcome =
  | { ok: true; value: PreparedFile }
  | { ok: false; error: PrepareFailure };

/** Named steps, in order; reported as progress and in overrun messages. */
export const PREPARE_PHASES = [
  "previous revision",
  "conversion",
  "metadata extraction",
  "code-region detection",
  "change-journal structure",
  "chunking",
  "link extraction",
] as const;

export type PreparePhase = (typeof PREPARE_PHASES)[number];

export interface PrepareHooks {
  convert: (input: ConvertInput) => Promise<PipelineResult>;
  chunker: ChunkerPort;
  /** Called once the previous revision's structure is known (if any). */
  onPrevious: (structure: DocumentStructureSnapshot) => void;
  /** Called as each step starts. */
  onPhase: (phase: PreparePhase) => void;
  /** In-process budget checkpoint after a step; null to continue. */
  check: (phase: PreparePhase) => PrepareFailure | null;
}

const toLinkInputs = (
  markdown: string,
  relPath: string,
  excludedRanges: ExcludedRange[] | null
): DocLinkInput[] => {
  // Only Markdown sources carry links, as in Obsidian: link-shaped text in
  // code, plain text or converted documents stays searchable prose.
  if (!excludedRanges) return [];
  const linkInputs: DocLinkInput[] = [];
  for (const link of parseLinks(
    markdown,
    buildLineOffsets(markdown),
    excludedRanges
  )) {
    let targetRefNorm: string;
    if (link.kind === "wiki") {
      targetRefNorm = normalizeWikiName(link.targetRef);
    } else {
      // Markdown links with a collection prefix are not supported, and a
      // link that escapes the collection root is skipped.
      if (link.targetCollection) continue;
      const resolved = normalizeMarkdownPath(link.targetRef, relPath);
      if (!resolved) continue;
      targetRefNorm = resolved;
    }
    linkInputs.push({
      targetRef: link.targetRef,
      targetRefNorm,
      targetAnchor: link.targetAnchor,
      targetCollection: link.targetCollection,
      linkType: link.kind,
      linkText: link.displayText,
      startLine: link.startLine,
      startCol: link.startCol,
      endLine: link.endLine,
      endCol: link.endCol,
    });
  }
  return linkInputs;
};

/** Prepare one file for persistence; see the module comment. */
export async function prepareFile(
  request: PrepareFileRequest,
  hooks: PrepareHooks
): Promise<PrepareOutcome> {
  const { input, previous } = request;
  const relPath = input.relativePath;
  const step = (phase: PreparePhase): PrepareFailure | null =>
    hooks.check(phase);

  // The previous revision's structure comes first, so a file stopped later
  // still journals the evidence it had.
  let previousRanges: ExcludedRange[] | null = null;
  if (previous) {
    hooks.onPhase("previous revision");
    previousRanges = request.markdownSource
      ? getExcludedRanges(previous.markdown)
      : null;
    hooks.onPrevious(
      extractDocumentStructure(
        previous.markdown,
        previous.relPath,
        previous.dateFields,
        {
          markdownSource: request.markdownSource,
          excludedRanges: previousRanges ?? undefined,
        }
      )
    );
    const stop = step("previous revision");
    if (stop) return { ok: false, error: stop };
  }

  hooks.onPhase("conversion");
  const converted = await hooks.convert(input);
  if (!converted.ok) {
    return {
      ok: false,
      error: {
        code: converted.error.code,
        message: converted.error.message,
        details: converted.error.details,
      },
    };
  }
  const artifact = converted.value;
  const markdown = artifact.markdown;
  const stopAfterConversion = step("conversion");
  if (stopAfterConversion) return { ok: false, error: stopAfterConversion };

  hooks.onPhase("metadata extraction");
  const metadata = extractDocumentMetadata(
    markdown,
    relPath,
    request.metadataExt,
    request.contentTypeRules
  );
  const tags = extractTags(markdown);
  const memoryScopes = request.memoryManaged
    ? extractMemoryScopes(markdown)
    : null;
  const stopAfterMetadata = step("metadata extraction");
  if (stopAfterMetadata) return { ok: false, error: stopAfterMetadata };

  hooks.onPhase("code-region detection");
  const markdownSource = artifact.meta.converterId === MARKDOWN_CONVERTER_ID;
  // Unchanged content (a re-ingest) reuses the previous revision's parse.
  const excludedRanges = !markdownSource
    ? null
    : previous && previousRanges && previous.markdown === markdown
      ? previousRanges
      : getExcludedRanges(markdown);
  const stopAfterRanges = step("code-region detection");
  if (stopAfterRanges) return { ok: false, error: stopAfterRanges };

  hooks.onPhase("change-journal structure");
  const nextStructure = extractDocumentStructure(
    markdown,
    relPath,
    metadata.dateFields,
    { markdownSource, excludedRanges: excludedRanges ?? undefined }
  );
  const stopAfterStructure = step("change-journal structure");
  if (stopAfterStructure) return { ok: false, error: stopAfterStructure };

  hooks.onPhase("chunking");
  const chunkInputs: ChunkInput[] = hooks.chunker
    .chunk(
      markdown,
      request.chunkParams,
      artifact.languageHint ?? request.collectionLanguageHint,
      relPath
    )
    .map((c) => ({
      seq: c.seq,
      pos: c.pos,
      text: c.text,
      startLine: c.startLine,
      endLine: c.endLine,
      language: c.language ?? undefined,
      tokenCount: c.tokenCount ?? undefined,
    }));
  const stopAfterChunking = step("chunking");
  if (stopAfterChunking) return { ok: false, error: stopAfterChunking };

  hooks.onPhase("link extraction");
  const linkInputs = toLinkInputs(markdown, relPath, excludedRanges);
  const stopAfterLinks = step("link extraction");
  if (stopAfterLinks) return { ok: false, error: stopAfterLinks };

  return {
    ok: true,
    value: {
      artifact,
      metadata,
      nextStructure,
      chunkInputs,
      linkInputs,
      tags,
      memoryScopes,
    },
  };
}
