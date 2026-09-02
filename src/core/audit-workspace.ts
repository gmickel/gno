/** Real read-only workspace snapshot adapter shared by CLI and MCP. */

// node:path has no Bun equivalent.
import { join } from "node:path";

import type { Collection, Config } from "../config/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { DocumentRow } from "../store/types";
import type {
  AuditCategory,
  AuditFingerprints,
  AuditRunResult,
  AuditScope,
} from "./audit";
import type {
  AuditFreshnessDocument,
  AuditFreshnessOptions,
} from "./audit-freshness";
import type { AuditProvenanceDocument } from "./audit-provenance";

import {
  captureAuditLinkSnapshot,
  type AuditLinkSnapshot,
} from "../store/sqlite/graph-link-resolver";
import {
  AUDIT_RULE_SET_VERSION,
  canonicalAuditJson,
  hashAuditCanonical,
  runAudit,
} from "./audit";
import { evaluateFreshnessAudit } from "./audit-freshness";
import { evaluateLinkAudit } from "./audit-links";
import { evaluateProvenanceAudit } from "./audit-provenance";
import {
  extractCaptureSourceFromFrontmatter,
  hasDeclaredCaptureSource,
} from "./capture";
import { MARKDOWN_SOURCE_EXTENSIONS } from "./document-capabilities";
import { normalizeTag } from "./tags";
import { normalizeCollectionName } from "./validation";

export const AUDIT_WORKSPACE_MAX_DOCUMENTS = 10_000;
const AUDIT_PATH_FILTER_MAX_CHARS = 2048;
const AUDIT_SOURCE_CONCURRENCY = 16;
const AUDIT_FRONTMATTER_BYTES = 64 * 1024;
const FRONTMATTER_OPEN = /^---\r?\n/;
const FRONTMATTER_COMPLETE = /^---\r?\n[\s\S]*?(?:\r?\n)?---(?:\r?\n|$)/;

export interface WorkspaceAuditOptions {
  store: SqliteAdapter;
  config: Config;
  collections: readonly Collection[];
  indexName: string;
  categories: readonly AuditCategory[];
  collectionFilters?: readonly string[];
  pathFilters?: readonly string[];
  tagFilters?: readonly string[];
  maxFindings?: number;
  agePolicy?: AuditFreshnessOptions["agePolicy"];
  orphanRoots?: readonly string[];
  orphanIgnorePrefixes?: readonly string[];
  signal?: AbortSignal;
  now?: Date;
  onProgress?: (progress: WorkspaceAuditProgress) => void | Promise<void>;
}

export interface WorkspaceAuditProgress {
  phase: "snapshot" | "rules" | "complete";
  completed: number;
  total: number;
}

interface WorkspaceDocumentSnapshot {
  document: DocumentRow;
  provenance: AuditProvenanceDocument;
  freshness: AuditFreshnessDocument;
}

interface WorkspaceSnapshot {
  documents: WorkspaceDocumentSnapshot[];
  links: AuditLinkSnapshot;
  truncated: boolean;
}

const normalizeValues = (values: readonly string[] | undefined): string[] =>
  [...new Set((values ?? []).map((value) => value.normalize("NFC").trim()))]
    .filter(Boolean)
    .sort();

const collectionPathMap = (
  collections: readonly Collection[]
): Map<string, string> =>
  new Map(collections.map((collection) => [collection.name, collection.path]));

const selectDocuments = async (
  store: SqliteAdapter,
  options: {
    collections: readonly string[];
    paths: readonly string[];
    tags: readonly string[];
  }
): Promise<{ documents: DocumentRow[]; total: number; truncated: boolean }> => {
  const listed = await store.listDocumentsForAudit({
    collections: options.collections,
    pathPrefixes: options.paths,
    tags: options.tags,
    limit: AUDIT_WORKSPACE_MAX_DOCUMENTS,
  });
  if (!listed.ok) throw new Error(listed.error.message);
  return {
    documents: listed.value.documents,
    total: listed.value.total,
    truncated: listed.value.total > AUDIT_WORKSPACE_MAX_DOCUMENTS,
  };
};

const hashBlob = async (file: Blob, signal?: AbortSignal): Promise<string> => {
  const hasher = new Bun.CryptoHasher("sha256");
  signal?.throwIfAborted();
  for await (const chunk of file.stream()) {
    signal?.throwIfAborted();
    hasher.update(chunk);
  }
  return hasher.digest("hex");
};

const mapConcurrent = async <T, R>(
  values: readonly T[],
  mapper: (value: T) => Promise<R>
): Promise<R[]> => {
  const output = Array.from({ length: values.length }, () => undefined as R);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value !== undefined) output[index] = await mapper(value);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(AUDIT_SOURCE_CONCURRENCY, values.length) },
      worker
    )
  );
  return output;
};

export interface AuditPhysicalSourceDescriptor {
  key: string;
  collection: string;
  relPath: string;
  markdownSource: boolean;
}

/** Collapse logical records that share one physical export/container. */
export const groupAuditPhysicalSources = (
  documents: readonly DocumentRow[]
): AuditPhysicalSourceDescriptor[] => {
  const grouped = new Map<string, AuditPhysicalSourceDescriptor>();
  for (const document of documents) {
    const recordSourcePath = document.recordSourcePath?.trim();
    const relPath =
      document.recordKey != null && recordSourcePath
        ? recordSourcePath
        : document.relPath;
    const key = JSON.stringify([document.collection, relPath]);
    const markdownSource = MARKDOWN_SOURCE_EXTENSIONS.has(
      document.sourceExt.toLowerCase()
    );
    const existing = grouped.get(key);
    if (existing) {
      existing.markdownSource ||= markdownSource;
    } else {
      grouped.set(key, {
        key,
        collection: document.collection,
        relPath,
        markdownSource,
      });
    }
  }
  return [...grouped.values()].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  );
};

const observeDocument = async (
  document: DocumentRow,
  roots: ReadonlyMap<string, string>,
  managedCollections: ReadonlySet<string>,
  readFrontmatter: boolean,
  inspectFreshness: boolean,
  signal?: AbortSignal
): Promise<WorkspaceDocumentSnapshot> => {
  const markdownSource = MARKDOWN_SOURCE_EXTENSIONS.has(
    document.sourceExt.toLowerCase()
  );
  const memoryManaged = managedCollections.has(document.collection);
  const memoryUnreadable = memoryManaged ? { content: null } : undefined;
  const root = roots.get(document.collection);
  if (!root) {
    return {
      document,
      provenance: {
        uri: document.uri,
        relPath: document.relPath,
        sourceState: "unreadable",
        captureSourceSupported: markdownSource,
        captureSourceDeclared: false,
        memory: memoryUnreadable,
        record: document,
      },
      freshness: {
        uri: document.uri,
        relPath: document.relPath,
        contentType: document.contentType ?? null,
        indexedSourceHash: document.sourceHash,
        indexedSourceMtime: document.sourceMtime,
        indexedAt: document.indexedAt ?? null,
        lastErrorCode: document.lastErrorCode,
        source: { state: "unreadable", hash: null, mtime: null },
      },
    };
  }
  const recordSourcePath = document.recordSourcePath?.trim();
  const logicalRecord =
    document.recordKey != null &&
    recordSourcePath !== undefined &&
    recordSourcePath.length > 0;
  const file = Bun.file(
    join(root, logicalRecord ? recordSourcePath : document.relPath)
  );
  try {
    if (!(await file.exists())) {
      return {
        document,
        provenance: {
          uri: document.uri,
          relPath: document.relPath,
          sourceState: "missing",
          captureSourceSupported: markdownSource,
          captureSourceDeclared: false,
          memory: memoryUnreadable,
          record: document,
        },
        freshness: {
          uri: document.uri,
          relPath: document.relPath,
          contentType: document.contentType ?? null,
          indexedSourceHash: document.sourceHash,
          indexedSourceMtime: document.sourceMtime,
          indexedAt: document.indexedAt ?? null,
          lastErrorCode: document.lastErrorCode,
          source: { state: "missing", hash: null, mtime: null },
        },
      };
    }
    const beforeMtime = file.lastModified;
    const beforeSize = file.size;
    // Freshness must hash readable bytes even when size/mtime still match the
    // indexed metadata — metadata-preserving restores can drift without a
    // stat change.
    const observedHash =
      inspectFreshness && !logicalRecord
        ? await hashBlob(file, signal)
        : inspectFreshness
          ? null
          : document.sourceHash;
    const frontmatter =
      readFrontmatter && markdownSource
        ? await file.slice(0, AUDIT_FRONTMATTER_BYTES).text()
        : "";
    const incompleteFrontmatter =
      readFrontmatter &&
      markdownSource &&
      FRONTMATTER_OPEN.test(frontmatter) &&
      !FRONTMATTER_COMPLETE.test(frontmatter);
    const afterMtime = file.lastModified;
    const afterSize = file.size;
    return {
      document,
      provenance: {
        uri: document.uri,
        relPath: document.relPath,
        sourceState: incompleteFrontmatter ? "unreadable" : "readable",
        captureSourceSupported: markdownSource,
        captureSourceDeclared:
          !incompleteFrontmatter && hasDeclaredCaptureSource(frontmatter),
        captureSource: incompleteFrontmatter
          ? undefined
          : extractCaptureSourceFromFrontmatter(frontmatter),
        // Memory facts are small single files, so the bounded frontmatter
        // read covers the whole record the validator needs.
        memory: memoryManaged
          ? { content: incompleteFrontmatter ? null : frontmatter }
          : undefined,
        record: document,
      },
      freshness: {
        uri: document.uri,
        relPath: document.relPath,
        contentType: document.contentType ?? null,
        indexedSourceHash: document.sourceHash,
        indexedSourceMtime: document.sourceMtime,
        indexedAt: document.indexedAt ?? null,
        lastErrorCode: document.lastErrorCode,
        source: {
          state: "readable",
          hash: observedHash,
          mtime: new Date(afterMtime).toISOString(),
          byteComparable: !logicalRecord,
          changedDuringRead:
            beforeMtime !== afterMtime || beforeSize !== afterSize,
        },
      },
    };
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return {
      document,
      provenance: {
        uri: document.uri,
        relPath: document.relPath,
        sourceState: "unreadable",
        captureSourceSupported: markdownSource,
        captureSourceDeclared: false,
        memory: memoryUnreadable,
        record: document,
      },
      freshness: {
        uri: document.uri,
        relPath: document.relPath,
        contentType: document.contentType ?? null,
        indexedSourceHash: document.sourceHash,
        indexedSourceMtime: document.sourceMtime,
        indexedAt: document.indexedAt ?? null,
        lastErrorCode: document.lastErrorCode,
        source: { state: "unreadable", hash: null, mtime: null },
      },
    };
  }
};

const filterLinkSnapshot = (
  snapshot: AuditLinkSnapshot,
  selectedIds: ReadonlySet<number>,
  selectedDocuments: readonly DocumentRow[],
  selectionTruncated: boolean
): AuditLinkSnapshot => {
  const links = snapshot.links.filter(
    (link) =>
      selectedIds.has(link.sourceId) ||
      (link.resolved !== null && selectedIds.has(link.resolved.targetId))
  );
  const outgoingTotal = snapshot.links.filter((link) =>
    selectedIds.has(link.sourceId)
  ).length;
  return {
    ...snapshot,
    // Preserve graph-wide documents as duplicate-mirror evidence while the
    // explicit id set prevents findings outside the requested audit scope.
    auditedDocumentIds: [...selectedIds],
    links,
    totals: { documents: selectedDocuments.length, links: outgoingTotal },
    truncated: {
      documents: selectionTruncated || snapshot.truncated.documents,
      links: snapshot.truncated.links,
    },
  };
};

const emptyLinkSnapshot = (): AuditLinkSnapshot => ({
  documents: [],
  links: [],
  totals: { documents: 0, links: 0 },
  truncated: { documents: false, links: false },
  metrics: {
    documentRowsExamined: 0,
    linkRowsExamined: 0,
    uniqueTargetsResolved: 0,
    batchedResolution: true,
  },
});

const loadWorkspaceSnapshot = async (
  options: WorkspaceAuditOptions,
  filters: { collections: string[]; paths: string[]; tags: string[] }
): Promise<WorkspaceSnapshot> => {
  const selected = await selectDocuments(options.store, filters);
  const roots = collectionPathMap(options.collections);
  const needsSourceObservation =
    options.categories.includes("provenance") ||
    options.categories.includes("freshness");
  const managedCollections = new Set(
    options.collections
      .filter((collection) => collection.memoryManaged === true)
      .map((collection) => collection.name)
  );
  const observed = needsSourceObservation
    ? await mapConcurrent(selected.documents, (document) =>
        observeDocument(
          document,
          roots,
          managedCollections,
          options.categories.includes("provenance"),
          options.categories.includes("freshness"),
          options.signal
        )
      )
    : [];
  await options.onProgress?.({
    phase: "snapshot",
    completed: selected.documents.length,
    total: selected.total,
  });
  // Capture the bounded graph before narrowing link scope so incoming edges
  // from outside a filter still prevent false orphans. Source-only audits do
  // not touch the unrelated graph.
  const rawLinks =
    options.categories.includes("links") && selected.documents.length > 0
      ? captureAuditLinkSnapshot(options.store.getRawDb())
      : emptyLinkSnapshot();
  const selectedIds = new Set(selected.documents.map(({ id }) => id));
  return {
    documents: observed,
    links: filterLinkSnapshot(
      rawLinks,
      selectedIds,
      selected.documents,
      selected.truncated
    ),
    truncated: selected.truncated,
  };
};

const captureWorkspaceFingerprints = async (
  options: WorkspaceAuditOptions,
  filters: { collections: string[]; paths: string[]; tags: string[] }
): Promise<AuditFingerprints> => {
  options.signal?.throwIfAborted();
  const selected = await selectDocuments(options.store, filters);
  const needsSourceFingerprint =
    options.categories.includes("provenance") ||
    options.categories.includes("freshness");
  const inspectFreshness = options.categories.includes("freshness");
  const inspectProvenance = options.categories.includes("provenance");
  const roots = collectionPathMap(options.collections);
  const sourceStats = needsSourceFingerprint
    ? await mapConcurrent(
        groupAuditPhysicalSources(selected.documents),
        async (source) => {
          const root = roots.get(source.collection);
          if (!root)
            return {
              collection: source.collection,
              path: source.relPath,
              state: "unavailable",
            };
          const file = Bun.file(join(root, source.relPath));
          try {
            const exists = await file.exists();
            if (!exists)
              return {
                collection: source.collection,
                path: source.relPath,
                state: "missing",
              };
            const hash = inspectFreshness
              ? await hashBlob(file, options.signal)
              : inspectProvenance && source.markdownSource
                ? await hashBlob(
                    file.slice(0, AUDIT_FRONTMATTER_BYTES),
                    options.signal
                  )
                : null;
            return {
              collection: source.collection,
              path: source.relPath,
              state: "readable",
              size: file.size,
              mtime: file.lastModified,
              hash,
            };
          } catch (cause) {
            if (options.signal?.aborted) throw cause;
            return {
              collection: source.collection,
              path: source.relPath,
              state: "unavailable",
            };
          }
        }
      )
    : [];
  // Link audits fingerprint the same unscoped bounded graph capture the rules
  // use, so concurrent doc_links / resolution changes retry or report
  // changed_during_audit even when document revision fields are unchanged.
  const linkGraph =
    options.categories.includes("links") && selected.documents.length > 0
      ? captureAuditLinkSnapshot(options.store.getRawDb())
      : null;
  return {
    config: hashAuditCanonical({
      collections: options.collections.map(({ name, path, pattern }) => ({
        name,
        path,
        pattern,
      })),
      filters,
    }),
    source: hashAuditCanonical({ sourceStats, total: selected.total }),
    index: hashAuditCanonical({
      documents: selected.documents.map((document) => ({
        uri: document.uri,
        relPath: document.relPath,
        sourceExt: document.sourceExt,
        sourceHash: document.sourceHash,
        sourceMtime: document.sourceMtime,
        contentType: document.contentType ?? null,
        indexedAt: document.indexedAt ?? null,
        lastErrorCode: document.lastErrorCode,
        converterId: document.converterId,
        converterVersion: document.converterVersion,
        recordKey: document.recordKey ?? null,
        recordSourcePath: document.recordSourcePath ?? null,
        recordSourceLocator: document.recordSourceLocator ?? null,
        recordAdapterFingerprint: document.recordAdapterFingerprint ?? null,
        recordMetadata: document.recordMetadata ?? null,
        recordAnchors: document.recordAnchors ?? null,
      })),
      total: selected.total,
      linkGraph,
    }),
    rules: hashAuditCanonical({
      ruleSet: AUDIT_RULE_SET_VERSION,
      categories: options.categories,
      agePolicy: options.agePolicy ?? null,
      orphanRoots: normalizeValues(options.orphanRoots),
      orphanIgnorePrefixes: normalizeValues(options.orphanIgnorePrefixes),
    }),
  };
};

export const runWorkspaceAudit = async (
  options: WorkspaceAuditOptions
): Promise<AuditRunResult> => {
  const rawPaths = options.pathFilters ?? [];
  const normalizedPathInputs = rawPaths.map((path) =>
    path.normalize("NFC").trim()
  );
  if (normalizedPathInputs.some((path) => path.length === 0)) {
    return {
      ok: false,
      exit: "invalid",
      error: "path filters must not be empty or whitespace-only",
    };
  }
  if (
    normalizedPathInputs.some(
      (path) => path.length > AUDIT_PATH_FILTER_MAX_CHARS
    )
  ) {
    return {
      ok: false,
      exit: "invalid",
      error: `path filters must be at most ${AUDIT_PATH_FILTER_MAX_CHARS} characters`,
    };
  }
  const normalizedPaths = normalizeValues(normalizedPathInputs).map((path) =>
    path.replace(/^\/+|\/+$/g, "")
  );
  const filters = {
    collections: normalizeValues(options.collectionFilters).map(
      normalizeCollectionName
    ),
    // A root-like prefix means the whole selected collection. Remove it from
    // both selection and reported scope instead of producing an empty match.
    paths: normalizedPaths.includes("") ? [] : normalizedPaths,
    tags: normalizeValues(options.tagFilters).map(normalizeTag),
  };
  const scope: AuditScope = {
    categories: [...options.categories],
    collections: filters.collections,
    paths: filters.paths,
    tags: filters.tags,
    indexName: options.indexName,
  };
  await options.onProgress?.({ phase: "snapshot", completed: 0, total: 1 });
  const snapshots = new Map<number, Promise<WorkspaceSnapshot>>();
  const snapshotFor = (attempt: number): Promise<WorkspaceSnapshot> => {
    const existing = snapshots.get(attempt);
    if (existing) return existing;
    const pending = loadWorkspaceSnapshot(options, filters);
    snapshots.set(attempt, pending);
    return pending;
  };
  const result = await runAudit({
    scope,
    capabilities: {
      indexReadable: true,
      sourcesReadable: true,
      linksGraphAvailable: true,
      provenanceSchemaAvailable: true,
      offline: true,
      llmDisabled: true,
    },
    captureFingerprints: () => captureWorkspaceFingerprints(options, filters),
    signal: options.signal,
    maxFindings: options.maxFindings,
    rules: [
      async ({ attempt }) => {
        if (options.signal?.aborted) {
          return {
            ruleId: "audit.cancelled",
            category: options.categories[0] ?? "links",
            status: "inconclusive",
            message: "Audit was cancelled",
            findings: [],
            findingCount: 0,
            skipReason: "cancelled",
          };
        }
        const snapshot = await snapshotFor(attempt);
        if (options.signal?.aborted) {
          return {
            ruleId: "audit.cancelled",
            category: options.categories[0] ?? "links",
            status: "inconclusive",
            message: "Audit was cancelled",
            findings: [],
            findingCount: 0,
            skipReason: "cancelled",
          };
        }
        const contributions = [];
        await options.onProgress?.({
          phase: "rules",
          completed: 0,
          total: options.categories.length,
        });
        if (options.categories.includes("links")) {
          contributions.push(
            ...evaluateLinkAudit(snapshot.links, {
              rootUris: options.orphanRoots ?? [],
              ignorePathPrefixes: options.orphanIgnorePrefixes ?? [],
            })
          );
          await options.onProgress?.({
            phase: "rules",
            completed: 1,
            total: options.categories.length,
          });
        }
        if (options.categories.includes("provenance")) {
          contributions.push(
            ...evaluateProvenanceAudit(
              snapshot.documents.map(({ provenance }) => provenance),
              { truncated: snapshot.truncated }
            )
          );
          await options.onProgress?.({
            phase: "rules",
            completed: Number(options.categories.includes("links")) + 1,
            total: options.categories.length,
          });
        }
        if (options.categories.includes("freshness")) {
          contributions.push(
            ...evaluateFreshnessAudit(
              snapshot.documents.map(({ freshness }) => freshness),
              {
                now: options.now ?? new Date(),
                agePolicy: options.agePolicy,
                truncated: snapshot.truncated,
              }
            )
          );
          await options.onProgress?.({
            phase: "rules",
            completed: options.categories.length,
            total: options.categories.length,
          });
        }
        return contributions;
      },
    ],
  });
  await options.onProgress?.({ phase: "complete", completed: 1, total: 1 });
  return result;
};

export const auditReportBytes = (result: AuditRunResult): number =>
  new TextEncoder().encode(canonicalAuditJson(result)).byteLength;
