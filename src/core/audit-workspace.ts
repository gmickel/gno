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
import { normalizeTag } from "./tags";
import { normalizeCollectionName } from "./validation";

export const AUDIT_WORKSPACE_MAX_DOCUMENTS = 10_000;
const AUDIT_SOURCE_CONCURRENCY = 16;
const AUDIT_FRONTMATTER_BYTES = 64 * 1024;

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

const pathMatches = (relPath: string, prefixes: readonly string[]): boolean =>
  prefixes.length === 0 ||
  prefixes.some(
    (prefix) => relPath === prefix || relPath.startsWith(`${prefix}/`)
  );

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
  const listed = await store.listDocuments();
  if (!listed.ok) throw new Error(listed.error.message);
  let candidates = listed.value.filter(
    (document) =>
      document.active &&
      (options.collections.length === 0 ||
        options.collections.includes(document.collection)) &&
      pathMatches(document.relPath, options.paths)
  );
  if (options.tags.length > 0 && candidates.length > 0) {
    const tags = await store.getTagsBatch(candidates.map(({ id }) => id));
    if (!tags.ok) throw new Error(tags.error.message);
    candidates = candidates.filter((document) => {
      const documentTags = new Set(
        (tags.value.get(document.id) ?? []).map(({ tag }) => tag)
      );
      return options.tags.every((tag) => documentTags.has(tag));
    });
  }
  candidates.sort((left, right) => left.id - right.id);
  return {
    documents: candidates.slice(0, AUDIT_WORKSPACE_MAX_DOCUMENTS),
    total: candidates.length,
    truncated: candidates.length > AUDIT_WORKSPACE_MAX_DOCUMENTS,
  };
};

const hashFile = async (file: Bun.BunFile): Promise<string> => {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of file.stream()) hasher.update(chunk);
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

const observeDocument = async (
  document: DocumentRow,
  roots: ReadonlyMap<string, string>,
  readFrontmatter: boolean,
  inspectFreshness: boolean
): Promise<WorkspaceDocumentSnapshot> => {
  const root = roots.get(document.collection);
  if (!root) {
    return {
      document,
      provenance: {
        uri: document.uri,
        relPath: document.relPath,
        sourceState: "unreadable",
        captureSourceDeclared: false,
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
  const file = Bun.file(join(root, document.relPath));
  try {
    if (!(await file.exists())) {
      return {
        document,
        provenance: {
          uri: document.uri,
          relPath: document.relPath,
          sourceState: "missing",
          captureSourceDeclared: false,
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
    const observedHash = inspectFreshness
      ? await hashFile(file)
      : document.sourceHash;
    const frontmatter =
      readFrontmatter && document.sourceExt.toLowerCase() === ".md"
        ? await file.slice(0, AUDIT_FRONTMATTER_BYTES).text()
        : "";
    const afterMtime = file.lastModified;
    const afterSize = file.size;
    return {
      document,
      provenance: {
        uri: document.uri,
        relPath: document.relPath,
        sourceState: "readable",
        captureSourceDeclared: hasDeclaredCaptureSource(frontmatter),
        captureSource: extractCaptureSourceFromFrontmatter(frontmatter),
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
          changedDuringRead:
            beforeMtime !== afterMtime || beforeSize !== afterSize,
        },
      },
    };
  } catch {
    return {
      document,
      provenance: {
        uri: document.uri,
        relPath: document.relPath,
        sourceState: "unreadable",
        captureSourceDeclared: false,
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
    documents: snapshot.documents.filter((document) =>
      selectedIds.has(document.id)
    ),
    links,
    totals: { documents: selectedDocuments.length, links: outgoingTotal },
    truncated: {
      documents: selectionTruncated || snapshot.truncated.documents,
      links: snapshot.truncated.links,
    },
  };
};

const loadWorkspaceSnapshot = async (
  options: WorkspaceAuditOptions,
  filters: { collections: string[]; paths: string[]; tags: string[] }
): Promise<WorkspaceSnapshot> => {
  const selected = await selectDocuments(options.store, filters);
  const roots = collectionPathMap(options.collections);
  const needsSourceObservation =
    options.categories.includes("provenance") ||
    options.categories.includes("freshness");
  const observed = needsSourceObservation
    ? await mapConcurrent(selected.documents, (document) =>
        observeDocument(
          document,
          roots,
          options.categories.includes("provenance"),
          options.categories.includes("freshness")
        )
      )
    : [];
  await options.onProgress?.({
    phase: "snapshot",
    completed: selected.documents.length,
    total: selected.total,
  });
  // Capture the bounded graph before narrowing the document scope so incoming
  // edges from outside a collection/path filter still prevent false orphans.
  const rawLinks = captureAuditLinkSnapshot(options.store.getRawDb());
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
  const selected = await selectDocuments(options.store, filters);
  const needsSourceFingerprint =
    options.categories.includes("provenance") ||
    options.categories.includes("freshness");
  const roots = collectionPathMap(options.collections);
  const sourceStats = needsSourceFingerprint
    ? await mapConcurrent(selected.documents, async (document) => {
        const root = roots.get(document.collection);
        if (!root) return { uri: document.uri, state: "unavailable" };
        const file = Bun.file(join(root, document.relPath));
        const exists = await file.exists();
        return exists
          ? { uri: document.uri, size: file.size, mtime: file.lastModified }
          : { uri: document.uri, state: "missing" };
      })
    : [];
  // Link audits fingerprint the same unscoped bounded graph capture the rules
  // use, so concurrent doc_links / resolution changes retry or report
  // changed_during_audit even when document revision fields are unchanged.
  const linkGraph = options.categories.includes("links")
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
        sourceHash: document.sourceHash,
        indexedAt: document.indexedAt,
        lastErrorCode: document.lastErrorCode,
      })),
      total: selected.total,
      linkGraph,
    }),
    rules: hashAuditCanonical({
      ruleSet: AUDIT_RULE_SET_VERSION,
      categories: options.categories,
      agePolicy: options.agePolicy ?? null,
      orphanRoots: options.orphanRoots ?? [],
      orphanIgnorePrefixes: options.orphanIgnorePrefixes ?? [],
    }),
  };
};

export const runWorkspaceAudit = async (
  options: WorkspaceAuditOptions
): Promise<AuditRunResult> => {
  const filters = {
    collections: normalizeValues(options.collectionFilters).map(
      normalizeCollectionName
    ),
    paths: normalizeValues(options.pathFilters).map((path) =>
      path.replace(/^\/+/, "")
    ),
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
