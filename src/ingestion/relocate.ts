/**
 * Explicit relocation of indexed documents across collections (and paths).
 *
 * A file moved on disk to another collection is, to `gno update`, a new
 * document: it is read, hashed, converted, chunked and given new vector owner
 * bindings, and the old row is deactivated later. Relocation records the move
 * instead: the document keeps its database id, chunks, tags, annotations and
 * vector owners, and only what depends on its location is rewritten
 * (collection, path, URI, full-text filepath, path-derived metadata, parsed
 * links, change journal, graph projection).
 *
 * The fast path is taken only when normal ingestion of the destination file
 * would treat the moved row as unchanged; anything else is refused and left to
 * `gno update`. Moves are never inferred from hashes: identical bytes can be
 * an independent copy.
 *
 * @module src/ingestion/relocate
 */

// node:fs/promises for realpath/stat (no Bun equivalent for canonical paths or file stats)
import { realpath, stat } from "node:fs/promises";
// node:path for join/relative/extname (no Bun path utils)
import { extname, isAbsolute, join, relative, sep } from "node:path";

import type { Collection } from "../config/types";
import type { ConvertInput } from "../converters/types";
import type {
  DocLinkInput,
  DocumentChangeStructureDelta,
  DocumentInput,
  DocumentRow,
  StorePort,
} from "../store/types";
import type { PrepareFileRequest, PrepareOutcome } from "./prepare-file";
import type {
  DirectoryAvailabilityPort,
  SourceContentReaderPort,
} from "./source-availability";
import type { SyncOptions } from "./types";

import { buildUri, parseUri } from "../app/constants";
import { fingerprintContentTypeMetadataRules } from "../config";
import { chunkingPolicyKey, resolveChunkingParams } from "../config/chunking";
import { MARKDOWN_CONVERTER_ID } from "../converters/native/markdown";
import { DEFAULT_LIMITS } from "../converters/types";
import { diffDocumentStructure } from "../core/change-diff";
import {
  isCompiledContextContent,
  isCompiledContextPath,
} from "./compiled-context";
import { projectRelocatedPath } from "./prepare-file";
import {
  findUnprovenAvailabilityPrefix,
  resolveSourceAvailability,
} from "./source-availability";
import { unavailableRootMessage } from "./source-availability/root";
import { collectionToWalkConfig, DEFAULT_CHUNK_PARAMS } from "./types";
import { matchesWalkPath } from "./walker";

/** Why an item was not relocated. Stable, machine-readable. */
export type RelocationRefusalCode =
  /** Bad reference or destination syntax. */
  | "INVALID_REFERENCE"
  /** No indexed document (or no configured collection) matches. */
  | "NOT_FOUND"
  /** A reference matches several documents, or two items collide. */
  | "AMBIGUOUS"
  /** The destination is already indexed (active or inactive row). */
  | "DESTINATION_EXISTS"
  /** The destination path is not eligible in its collection. */
  | "DESTINATION_NOT_ELIGIBLE"
  /** No file at the destination. */
  | "DESTINATION_MISSING"
  /** The old path still holds a different file: possibly a copy. */
  | "SOURCE_STILL_PRESENT"
  /** Source availability rules could not prove the file state. */
  | "SOURCE_UNAVAILABLE"
  /** The destination bytes (or their conversion) differ from the indexed document. */
  | "SOURCE_CHANGED"
  /** The indexed row is inactive, failed, or from an older ingest version. */
  | "NEEDS_REINDEX"
  /** Collections or paths whose settings would derive different data. */
  | "INCOMPATIBLE"
  /** The store does not support relocation, or a write failed. */
  | "STORE_ERROR";

export interface RelocationRequest {
  /** `#docid`, `gno://collection/path`, `collection/path`, or a folder (`collection/dir/`). */
  source: string;
  /** `collection`, `collection/dir/` (folder) or `collection/path` (exact). */
  destination: string;
}

export interface RelocationItem {
  /** URI of the document before the move (the raw reference when unresolved). */
  source: string;
  /** URI the document moves (or would move) to, when one was resolved. */
  destination?: string;
  status: "relocated" | "would_relocate" | "refused";
  documentId?: number;
  docid?: string;
  code?: RelocationRefusalCode;
  message?: string;
  /**
   * The destination filename changed the document's title, so its vector
   * owners were invalidated and the next embed pass re-embeds it.
   */
  titleChanged?: boolean;
}

export interface RelocationResult {
  dryRun: boolean;
  relocated: number;
  refused: number;
  items: RelocationItem[];
  /** Graph projection failures after the moves (moves themselves are committed). */
  projectionErrors: Array<{ relPath: string; code: string; message: string }>;
  durationMs: number;
}

/** One resolved move: an indexed row and where it goes. */
export interface PlannedRelocation {
  document: DocumentRow;
  collection: string;
  relPath: string;
}

export type PlanEntry =
  | { kind: "planned"; move: PlannedRelocation }
  | { kind: "refused"; item: RelocationItem };

interface ParsedLocation {
  collection: string;
  /** Path below the collection root; ends with `/` (or is empty) for a folder. */
  path: string;
}

type ParsedSource =
  | { kind: "docid"; docid: string }
  | { kind: "path"; location: ParsedLocation };

const DOCID_PATTERN = /^#[a-f0-9]{6,}$/;

/** Moves whose writes commit in one transaction (as `gno update` batches files). */
const RELOCATION_BATCH_SIZE = 50;

function parseLocation(ref: string): ParsedLocation | string {
  if (ref.startsWith("gno://")) {
    const parsed = parseUri(ref);
    if (!parsed) return `Invalid URI: ${ref}`;
    if (parsed.indexName !== undefined) {
      return `Index-qualified URIs are not accepted here (use --index): ${ref}`;
    }
    if (!parsed.collection) return `Missing collection: ${ref}`;
    return { collection: parsed.collection, path: parsed.path };
  }
  const slash = ref.indexOf("/");
  const collection = slash === -1 ? ref : ref.slice(0, slash);
  const path = slash === -1 ? "" : ref.slice(slash + 1);
  if (!collection) return `Missing collection: ${ref}`;
  return { collection: collection.toLowerCase(), path };
}

function parseSource(ref: string): ParsedSource | string {
  if (ref.startsWith("#")) {
    return DOCID_PATTERN.test(ref)
      ? { kind: "docid", docid: ref }
      : `Invalid docid: ${ref}`;
  }
  if (!ref.startsWith("gno://") && !ref.includes("/")) {
    return `Source must name a document or folder (collection/path): ${ref}`;
  }
  const location = parseLocation(ref);
  return typeof location === "string" ? location : { kind: "path", location };
}

const isFolder = (path: string): boolean => path === "" || path.endsWith("/");

const basename = (relPath: string): string =>
  relPath.slice(relPath.lastIndexOf("/") + 1);

const dirname = (relPath: string): string => {
  const index = relPath.lastIndexOf("/");
  return index === -1 ? "" : relPath.slice(0, index + 1);
};

const refused = (
  source: string,
  code: RelocationRefusalCode,
  message: string,
  extra: Partial<RelocationItem> = {}
): PlanEntry => ({
  kind: "refused",
  item: { source, status: "refused", code, message, ...extra },
});

/**
 * Resolve requests to concrete moves. Folder sources expand to every active
 * document below them; each document keeps its path relative to the source
 * folder (a single document: its filename) below the destination folder.
 */
export async function planRelocations(
  store: StorePort,
  collections: readonly Collection[],
  requests: readonly RelocationRequest[]
): Promise<PlanEntry[]> {
  const configured = new Set(collections.map((c) => c.name));
  const entries: PlanEntry[] = [];
  const listed = new Map<string, DocumentRow[]>();

  for (const request of requests) {
    const source = parseSource(request.source.trim());
    if (typeof source === "string") {
      entries.push(refused(request.source, "INVALID_REFERENCE", source));
      continue;
    }
    const destination = parseLocation(request.destination.trim());
    if (typeof destination === "string") {
      entries.push(refused(request.source, "INVALID_REFERENCE", destination));
      continue;
    }
    if (!configured.has(destination.collection)) {
      entries.push(
        refused(
          request.source,
          "NOT_FOUND",
          `Collection not found: ${destination.collection}`
        )
      );
      continue;
    }

    // Documents the request names, with the prefix their paths are kept below.
    let matched: Array<{ document: DocumentRow; keepBelow: string }>;
    if (source.kind === "docid") {
      const found = await store.getDocumentsByDocids([source.docid], {
        activeOnly: true,
      });
      if (!found.ok) {
        entries.push(
          refused(request.source, "STORE_ERROR", found.error.message)
        );
        continue;
      }
      if (found.value.length > 1) {
        entries.push(
          refused(
            request.source,
            "AMBIGUOUS",
            `${source.docid} matches ${found.value.length} documents (identical copies); name one by path`
          )
        );
        continue;
      }
      const document = found.value[0];
      if (!document) {
        entries.push(
          refused(
            request.source,
            "NOT_FOUND",
            `Document not found: ${source.docid}`
          )
        );
        continue;
      }
      matched = [{ document, keepBelow: dirname(document.relPath) }];
    } else if (isFolder(source.location.path)) {
      if (!isFolder(destination.path)) {
        entries.push(
          refused(
            request.source,
            "INVALID_REFERENCE",
            "A folder source needs a folder destination (collection or collection/dir/)"
          )
        );
        continue;
      }
      const { collection, path: prefix } = source.location;
      let documents = listed.get(collection);
      if (!documents) {
        const all = await store.listDocuments(collection);
        if (!all.ok) {
          entries.push(
            refused(request.source, "STORE_ERROR", all.error.message)
          );
          continue;
        }
        documents = all.value.filter((document) => document.active);
        listed.set(collection, documents);
      }
      matched = documents
        .filter((document) => document.relPath.startsWith(prefix))
        .map((document) => ({ document, keepBelow: prefix }));
      if (matched.length === 0) {
        entries.push(
          refused(
            request.source,
            "NOT_FOUND",
            `No indexed documents below ${request.source}`
          )
        );
        continue;
      }
    } else {
      const { collection, path } = source.location;
      const found = await store.getDocument(collection, path);
      if (!found.ok) {
        entries.push(
          refused(request.source, "STORE_ERROR", found.error.message)
        );
        continue;
      }
      if (!found.value) {
        entries.push(
          refused(
            request.source,
            "NOT_FOUND",
            `Document not found: ${request.source}`
          )
        );
        continue;
      }
      matched = [{ document: found.value, keepBelow: dirname(path) }];
    }

    for (const { document, keepBelow } of matched) {
      const relPath = isFolder(destination.path)
        ? `${destination.path}${document.relPath.slice(keepBelow.length)}`
        : destination.path;
      entries.push({
        kind: "planned",
        move: { document, collection: destination.collection, relPath },
      });
    }
  }

  // One document, one destination: duplicates in a run are ambiguous.
  const bySource = new Map<number, number>();
  const byDestination = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== "planned") continue;
    const { document, collection, relPath } = entry.move;
    bySource.set(document.id, (bySource.get(document.id) ?? 0) + 1);
    const key = `${collection}\u0000${relPath}`;
    byDestination.set(key, (byDestination.get(key) ?? 0) + 1);
  }
  return entries.map((entry) => {
    if (entry.kind !== "planned") return entry;
    const { document, collection, relPath } = entry.move;
    const duplicateSource = (bySource.get(document.id) ?? 0) > 1;
    const duplicateDestination =
      (byDestination.get(`${collection}\u0000${relPath}`) ?? 0) > 1;
    if (!duplicateSource && !duplicateDestination) return entry;
    return refused(
      document.uri,
      "AMBIGUOUS",
      duplicateSource
        ? "The document is named more than once in this run"
        : "Several documents in this run move to the same destination",
      { documentId: document.id, docid: document.docid }
    );
  });
}

/** What relocation needs from the sync service (its guarded I/O and preparation). */
export interface RelocationDeps {
  ingestVersion: number;
  detectMime: (
    relPath: string,
    sniff: Uint8Array
  ) => { mime: string; ext: string };
  reader: (mode: "any" | "local") => SourceContentReaderPort;
  directoryAvailability: (mode: "any" | "local") => DirectoryAvailabilityPort;
  /** Whether a record adapter would take this file in `collection`. */
  hasRecordAdapter: (
    collection: Collection,
    mime: string,
    ext: string
  ) => Promise<boolean>;
  /** Budgeted conversion (the file worker), as `gno update` prepares a file. */
  prepare: (request: PrepareFileRequest) => Promise<PrepareOutcome>;
  /** Documents whose graph projection depends on `documentId` (and itself). */
  collectProjectionSources: (
    documentId: number,
    into: Set<number>
  ) => Promise<{ code: string; message: string } | null>;
  projectGraph: (
    sources: Set<number>
  ) => Promise<Array<{ relPath: string; code: string; message: string }>>;
}

interface PreparedMove {
  move: PlannedRelocation;
  destination: Collection;
  input: DocumentInput;
  links: DocLinkInput[] | null;
  titleChanged: boolean;
  structureDelta?: Partial<DocumentChangeStructureDelta>;
}

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;

/** The walker's path identity: no empty, `.` or `..` segments, no backslashes. */
const isCanonicalRelPath = (relPath: string): boolean =>
  relPath.length > 0 &&
  relPath.normalize() === relPath &&
  !relPath.includes("\\") &&
  !relPath.startsWith("/") &&
  relPath
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

type Check<T> = { ok: true; value: T } | { ok: false; item: RelocationItem };

/**
 * Check one planned move and derive the row it leaves behind, without
 * writing. Refuses whenever normal ingestion of the destination file would
 * not treat the moved row as unchanged.
 */
// oxlint-disable-next-line max-lines-per-function -- one linear checklist of refusals
async function prepareMove(
  deps: RelocationDeps,
  store: StorePort,
  byName: Map<string, Collection>,
  options: SyncOptions,
  move: PlannedRelocation
): Promise<Check<PreparedMove>> {
  const { document } = move;
  const destinationUri = buildUri(move.collection, move.relPath);
  const refuse = (
    code: RelocationRefusalCode,
    message: string
  ): Check<PreparedMove> => ({
    ok: false,
    item: {
      source: document.uri,
      destination: destinationUri,
      status: "refused",
      documentId: document.id,
      docid: document.docid,
      code,
      message,
    },
  });

  const source = byName.get(document.collection);
  const destination = byName.get(move.collection);
  if (!source) {
    return refuse(
      "NOT_FOUND",
      `Collection not configured: ${document.collection}`
    );
  }
  if (!destination) {
    return refuse("NOT_FOUND", `Collection not configured: ${move.collection}`);
  }
  if (
    document.collection === move.collection &&
    document.relPath === move.relPath
  ) {
    return refuse("INVALID_REFERENCE", "Source and destination are the same");
  }

  // The row must be what `gno update` would skip as unchanged.
  const rulesFingerprint =
    options.contentTypeRulesFingerprint ??
    fingerprintContentTypeMetadataRules(options.contentTypeRules ?? []);
  if (!document.active) {
    return refuse("NEEDS_REINDEX", "The document is inactive");
  }
  if (
    !document.mirrorHash ||
    document.lastErrorCode ||
    document.ingestVersion !== deps.ingestVersion ||
    (document.contentTypeRulesFingerprint ?? null) !== rulesFingerprint
  ) {
    return refuse(
      "NEEDS_REINDEX",
      "The document is not fully indexed under the current settings; run gno update"
    );
  }
  if (document.recordKey || document.recordSourcePath) {
    return refuse(
      "INCOMPATIBLE",
      "Records of a record container move with their container only"
    );
  }
  const records = await store.listRecordDocuments(
    document.collection,
    document.relPath
  );
  if (!records.ok) return refuse("STORE_ERROR", records.error.message);
  if (records.value.length > 0) {
    return refuse(
      "INCOMPATIBLE",
      "Record containers are not relocated; run gno update"
    );
  }
  if (source.memoryManaged === true || destination.memoryManaged === true) {
    return refuse(
      "INCOMPATIBLE",
      "Memory-managed collections are not relocated; run gno update"
    );
  }
  // The stored language must be the one ingestion would derive at the
  // destination: its collection's hint, or (with no collection hint on either
  // side) the converter's own.
  const storedLanguage = document.languageHint ?? null;
  const destinationLanguage = destination.languageHint ?? null;
  if (
    storedLanguage !== destinationLanguage &&
    !(destinationLanguage === null && (source.languageHint ?? null) === null)
  ) {
    return refuse(
      "INCOMPATIBLE",
      "The document's language hint differs from the destination collection's"
    );
  }
  // Chunks are reused, so they must already follow the configured policy.
  if (store.getAppliedChunkingPolicyKey) {
    const applied = await store.getAppliedChunkingPolicyKey(
      document.mirrorHash
    );
    if (!applied.ok) return refuse("STORE_ERROR", applied.error.message);
    if (
      applied.value !==
      chunkingPolicyKey(resolveChunkingParams(options.chunking))
    ) {
      return refuse(
        "NEEDS_REINDEX",
        "The document's chunks predate the configured chunking policy; run gno update"
      );
    }
  }
  if (
    extname(document.relPath).toLowerCase() !==
    extname(move.relPath).toLowerCase()
  ) {
    return refuse("INCOMPATIBLE", "The file extension changes");
  }

  // The destination must be a path `gno update` would index there.
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (
    !isCanonicalRelPath(move.relPath) ||
    isCompiledContextPath(move.relPath) ||
    !matchesWalkPath(
      move.relPath,
      collectionToWalkConfig(destination, 0, options)
    )
  ) {
    return refuse(
      "DESTINATION_NOT_ELIGIBLE",
      `Not an indexable path in collection ${destination.name}`
    );
  }
  const occupied = await store.getDocument(move.collection, move.relPath);
  if (!occupied.ok) return refuse("STORE_ERROR", occupied.error.message);
  if (occupied.value) {
    return refuse(
      "DESTINATION_EXISTS",
      occupied.value.active
        ? "The destination is already indexed"
        : "The destination has an inactive index row; run gno update instead"
    );
  }

  const mode = resolveSourceAvailability(destination, options);
  const unproven = await findUnprovenAvailabilityPrefix(
    destination.path,
    move.relPath,
    deps.directoryAvailability(mode)
  );
  if (unproven) return refuse("SOURCE_UNAVAILABLE", unproven.message);
  const absPath = join(destination.path, move.relPath);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(absPath);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? refuse("DESTINATION_MISSING", "No file at the destination")
      : refuse(
          "SOURCE_UNAVAILABLE",
          error instanceof Error ? error.message : "stat failed"
        );
  }
  if (!stats.isFile())
    return refuse("DESTINATION_MISSING", "The destination is not a file");
  let destinationReal: string;
  try {
    destinationReal = await realpath(absPath);
    const rootReal = await realpath(destination.path);
    if (!inside(rootReal, destinationReal)) {
      return refuse(
        "DESTINATION_NOT_ELIGIBLE",
        "The destination resolves outside its collection root"
      );
    }
    // A symlinked alias would index the file under a second path.
    if (
      relative(rootReal, destinationReal).split(sep).join("/") !== move.relPath
    ) {
      return refuse(
        "DESTINATION_NOT_ELIGIBLE",
        "The destination path is an alias (symlink) of another path"
      );
    }
  } catch {
    return refuse(
      "DESTINATION_NOT_ELIGIBLE",
      "The destination path could not be resolved safely"
    );
  }
  if (stats.size > limits.maxBytes) {
    return refuse(
      "INCOMPATIBLE",
      `File size ${stats.size} exceeds limit ${limits.maxBytes}`
    );
  }

  // The old path must be provably gone, or be this same file in a nested
  // collection root that the source collection no longer indexes.
  const sourceMode = resolveSourceAvailability(source, options);
  const sourceUnproven = await findUnprovenAvailabilityPrefix(
    source.path,
    document.relPath,
    deps.directoryAvailability(sourceMode)
  );
  if (sourceUnproven) {
    return refuse("SOURCE_UNAVAILABLE", sourceUnproven.message);
  }
  const oldPath = join(source.path, document.relPath);
  try {
    const oldReal = await realpath(oldPath);
    if (oldReal !== destinationReal) {
      return refuse(
        "SOURCE_STILL_PRESENT",
        "A file still exists at the old path; it may be a copy, so both are left to gno update"
      );
    }
    if (
      matchesWalkPath(
        document.relPath,
        collectionToWalkConfig(source, 0, options)
      )
    ) {
      return refuse(
        "SOURCE_STILL_PRESENT",
        `Collection ${source.name} still indexes this file at its old path; exclude it there first`
      );
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      return refuse("SOURCE_UNAVAILABLE", "The old path could not be checked");
    }
    const rootError = await unavailableRootMessage(source.path);
    if (rootError) return refuse("SOURCE_UNAVAILABLE", rootError);
  }

  const read = await deps.reader(mode).readAll(absPath, stats.size);
  if (!read.ok) return refuse("SOURCE_UNAVAILABLE", read.message);
  const bytes = read.bytes;
  if (isCompiledContextContent(bytes.subarray(0, 4096))) {
    return refuse(
      "DESTINATION_NOT_ELIGIBLE",
      "Compiled context is not indexed"
    );
  }
  const sourceHash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (sourceHash !== document.sourceHash) {
    return refuse(
      "SOURCE_CHANGED",
      "The file changed since it was indexed; run gno update"
    );
  }
  const mime = deps.detectMime(move.relPath, bytes.subarray(0, 512));
  if (mime.mime !== document.sourceMime || mime.ext !== document.sourceExt) {
    return refuse(
      "INCOMPATIBLE",
      "The file type is detected differently at the destination"
    );
  }
  if (await deps.hasRecordAdapter(destination, mime.mime, mime.ext)) {
    return refuse(
      "INCOMPATIBLE",
      "The destination collection reads this file as a record container"
    );
  }

  const sourceMtime = stats.mtime.toISOString();
  const sourceCtime = (
    stats.birthtime ??
    stats.ctime ??
    stats.mtime
  ).toISOString();
  const base: DocumentInput = {
    collection: move.collection,
    relPath: move.relPath,
    sourceHash: document.sourceHash,
    sourceMime: document.sourceMime,
    sourceExt: document.sourceExt,
    sourceSize: stats.size,
    sourceMtime,
    sourceCtime,
    title: document.title ?? undefined,
    mirrorHash: document.mirrorHash,
    converterId: document.converterId ?? undefined,
    converterVersion: document.converterVersion ?? undefined,
    languageHint: document.languageHint ?? undefined,
    contentType: document.contentType ?? undefined,
    contentTypeSource: document.contentTypeSource ?? undefined,
    categories: document.categories ?? undefined,
    author: document.author ?? undefined,
    frontmatterDate: document.frontmatterDate ?? undefined,
    dateFields: document.dateFields ?? undefined,
    typedMetadata: document.typedMetadata ?? undefined,
    metadataError: document.metadataError ?? undefined,
    ingestVersion: deps.ingestVersion,
    contentTypeRulesFingerprint: rulesFingerprint,
    changeJournal: false,
  };

  // Same path in another collection: nothing path-derived changes.
  if (document.relPath === move.relPath) {
    return {
      ok: true,
      value: {
        move,
        destination,
        input: base,
        links: null,
        titleChanged: false,
      },
    };
  }

  const markdownSource = document.converterId === MARKDOWN_CONVERTER_ID;
  if (basename(document.relPath) !== basename(move.relPath)) {
    // A new filename can change a filename-derived title: convert the
    // destination exactly as `gno update` would and require the same mirror.
    const content = await store.getContent(document.mirrorHash);
    if (!content.ok) return refuse("STORE_ERROR", content.error.message);
    const input: ConvertInput = {
      sourcePath: absPath,
      relativePath: move.relPath,
      collection: destination.name,
      bytes,
      mime: mime.mime,
      ext: mime.ext,
      limits,
    };
    const prepared = await deps.prepare({
      input,
      metadataExt: mime.ext,
      contentTypeRules: options.contentTypeRules ?? [],
      chunkParams: options.chunkingToken?.params ?? DEFAULT_CHUNK_PARAMS,
      collectionLanguageHint: destination.languageHint,
      memoryManaged: false,
      markdownSource,
      previous:
        content.value === null
          ? null
          : {
              markdown: content.value,
              relPath: document.relPath,
              dateFields: document.dateFields ?? null,
              converterId: document.converterId,
            },
    });
    if (!prepared.ok) {
      return refuse(
        "SOURCE_CHANGED",
        `Conversion at the destination failed: ${prepared.error.message}`
      );
    }
    const { artifact, metadata, linkInputs, nextStructure } = prepared.value;
    if (
      artifact.mirrorHash !== document.mirrorHash ||
      artifact.meta.converterId !== document.converterId ||
      artifact.meta.converterVersion !== document.converterVersion ||
      (artifact.languageHint ?? destination.languageHint ?? null) !==
        (document.languageHint ?? null)
    ) {
      return refuse(
        "SOURCE_CHANGED",
        "The file converts differently at the destination; run gno update"
      );
    }
    const previousStructure =
      content.value === null
        ? undefined
        : projectRelocatedPath({
            markdown: content.value,
            previousRelPath: document.relPath,
            relPath: document.relPath,
            metadataExt: document.sourceExt,
            contentTypeRules: options.contentTypeRules ?? [],
            markdownSource,
            previousDateFields: document.dateFields ?? null,
          }).previousStructure;
    const title = artifact.title ?? undefined;
    return {
      ok: true,
      value: {
        move,
        destination,
        input: { ...base, title, ...metadataFields(metadata) },
        links: linkInputs,
        titleChanged: (title ?? null) !== (document.title ?? null),
        structureDelta: diffDocumentStructure(previousStructure, nextStructure)
          .delta,
      },
    };
  }

  // Same filename, new path: re-derive path-dependent data from the mirror.
  const content = await store.getContent(document.mirrorHash);
  if (!content.ok) return refuse("STORE_ERROR", content.error.message);
  if (content.value === null) {
    return refuse(
      "NEEDS_REINDEX",
      "The indexed content is missing; run gno update"
    );
  }
  const projection = projectRelocatedPath({
    markdown: content.value,
    previousRelPath: document.relPath,
    relPath: move.relPath,
    metadataExt: document.sourceExt,
    contentTypeRules: options.contentTypeRules ?? [],
    markdownSource,
    previousDateFields: document.dateFields ?? null,
  });
  return {
    ok: true,
    value: {
      move,
      destination,
      input: { ...base, ...metadataFields(projection.metadata) },
      links: projection.linkInputs,
      titleChanged: false,
      structureDelta: diffDocumentStructure(
        projection.previousStructure,
        projection.nextStructure
      ).delta,
    },
  };
}

function metadataFields(
  metadata: ReturnType<typeof projectRelocatedPath>["metadata"]
): Partial<DocumentInput> {
  return {
    contentType: metadata.contentType,
    contentTypeSource: metadata.contentTypeSource,
    categories: metadata.categories,
    author: metadata.author,
    frontmatterDate: metadata.frontmatterDate,
    dateFields: metadata.dateFields,
    typedMetadata: metadata.typedMetadata,
    metadataError: metadata.metadataError,
  };
}

/** Apply one prepared move in a single transaction. */
async function writeMove(
  store: StorePort,
  prepared: PreparedMove
): Promise<
  | { ok: true; row: DocumentRow }
  | { ok: false; code: RelocationRefusalCode; message: string }
> {
  const relocate = store.relocateDocument?.bind(store);
  if (!relocate || !store.withTransaction) {
    return {
      ok: false,
      code: "STORE_ERROR",
      message: "This store cannot relocate documents",
    };
  }
  const { document } = prepared.move;
  let refusal: { code: RelocationRefusalCode; message: string } | null = null;
  const written = await store.withTransaction(async () => {
    const moved = await relocate({
      documentId: document.id,
      expected: {
        collection: document.collection,
        relPath: document.relPath,
        sourceHash: document.sourceHash,
        mirrorHash: document.mirrorHash ?? "",
      },
      collection: prepared.move.collection,
      relPath: prepared.move.relPath,
      structureDelta: prepared.structureDelta,
    });
    if (!moved.ok) {
      refusal = {
        code:
          moved.error.code === "ALREADY_EXISTS"
            ? "DESTINATION_EXISTS"
            : moved.error.code === "CONSTRAINT_VIOLATION"
              ? "SOURCE_CHANGED"
              : moved.error.code === "NOT_FOUND"
                ? "NOT_FOUND"
                : "STORE_ERROR",
        message: moved.error.message,
      };
      throw new Error(moved.error.message);
    }
    // The ordinary upsert rewrites path-derived fields and, on a title change,
    // invalidates owner bindings exactly as ingestion does.
    const upserted = await store.upsertDocument(prepared.input);
    if (!upserted.ok) throw new Error(upserted.error.message);
    if (prepared.titleChanged) {
      const fts = await store.syncDocumentFts(
        prepared.move.collection,
        prepared.move.relPath
      );
      if (!fts.ok) throw new Error(fts.error.message);
    }
    if (prepared.links) {
      const links = await store.setDocLinks(
        document.id,
        prepared.links,
        "parsed"
      );
      if (!links.ok) throw new Error(links.error.message);
    }
    const row = await store.getDocument(
      prepared.move.collection,
      prepared.move.relPath
    );
    if (!row.ok || !row.value)
      throw new Error("Relocated document disappeared");
    return row.value;
  });
  if (written.ok) return { ok: true, row: written.value };
  const failed = refusal as {
    code: RelocationRefusalCode;
    message: string;
  } | null;
  return failed
    ? { ok: false, ...failed }
    : { ok: false, code: "STORE_ERROR", message: written.error.message };
}

/**
 * Relocate planned moves one transaction each, then re-project the graph
 * once for every moved document and the documents linking to it.
 */
export async function executeRelocations(
  deps: RelocationDeps,
  store: StorePort,
  collections: readonly Collection[],
  plan: readonly PlanEntry[],
  options: SyncOptions & { dryRun?: boolean }
): Promise<RelocationResult> {
  const startedAt = performance.now();
  const byName = new Map(collections.map((c) => [c.name, c]));
  // Filled by plan position, so the receipt keeps the request order.
  const items: RelocationItem[] = Array.from({ length: plan.length });
  const projectionSources = new Set<number>();
  let pending: Array<{ index: number; prepared: PreparedMove }> = [];

  const itemFor = (
    prepared: PreparedMove,
    patch: Partial<RelocationItem>
  ): RelocationItem => ({
    source: prepared.move.document.uri,
    destination: buildUri(prepared.move.collection, prepared.move.relPath),
    status: "refused",
    documentId: prepared.move.document.id,
    docid: prepared.move.document.docid,
    ...patch,
  });

  // Files are read and converted outside any transaction; the writes of up
  // to RELOCATION_BATCH_SIZE moves then commit together, each move in its
  // own savepoint so one refusal never rolls back another.
  const flush = async () => {
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    const apply = async () => {
      for (const { index, prepared } of batch) {
        const before = await deps.collectProjectionSources(
          prepared.move.document.id,
          projectionSources
        );
        if (before) {
          items[index] = itemFor(prepared, {
            code: "STORE_ERROR",
            message: before.message,
          });
          continue;
        }
        const written = await writeMove(store, prepared);
        if (!written.ok) {
          items[index] = itemFor(prepared, {
            code: written.code,
            message: written.message,
          });
          continue;
        }
        await deps.collectProjectionSources(written.row.id, projectionSources);
        items[index] = itemFor(prepared, {
          destination: written.row.uri,
          status: "relocated",
          titleChanged: prepared.titleChanged,
        });
      }
    };
    if (!store.withTransaction) {
      await apply();
      return;
    }
    const committed = await store.withTransaction(apply);
    if (!committed.ok) {
      // The batch rolled back as a whole: report every move in it as failed.
      for (const { index, prepared } of batch) {
        items[index] = itemFor(prepared, {
          code: "STORE_ERROR",
          message: committed.error.message,
        });
      }
    }
  };

  for (const [index, entry] of plan.entries()) {
    if (entry.kind === "refused") {
      items[index] = entry.item;
      continue;
    }
    const checked = await prepareMove(deps, store, byName, options, entry.move);
    if (!checked.ok) {
      items[index] = checked.item;
      continue;
    }
    if (options.dryRun) {
      items[index] = itemFor(checked.value, {
        status: "would_relocate",
        titleChanged: checked.value.titleChanged,
      });
      continue;
    }
    pending.push({ index, prepared: checked.value });
    if (pending.length >= RELOCATION_BATCH_SIZE) await flush();
  }
  await flush();

  const relocated = items.filter((item) => item.status === "relocated").length;
  const projectionErrors =
    relocated > 0 ? await deps.projectGraph(projectionSources) : [];
  return {
    dryRun: options.dryRun === true,
    relocated: options.dryRun
      ? items.filter((item) => item.status === "would_relocate").length
      : relocated,
    refused: items.filter((item) => item.status === "refused").length,
    items,
    projectionErrors,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
