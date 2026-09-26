/** Incremental graph inventory closure; full projection remains the repair oracle. */
import type {
  DocEdgeInput,
  DocumentRow,
  GraphReferenceDocument,
  GraphReferenceInventory,
  StorePort,
} from "../store/types";
import type { SyncOptions } from "./types";

import {
  isRelationMap,
  normalizeRelationEdgeType,
  normalizeRelationTarget,
} from "../core/change-diff";
import { LINK_RESOLVER_VERSION } from "../core/link-workspace";
import {
  normalizeMarkdownPath,
  normalizeWikiName,
  parseTargetParts,
} from "../core/links";
import {
  createInMemoryWorkspaceResolver,
  membershipsFromCollectionRows,
} from "../store/sqlite/workspace-link-resolver";
import { parseFrontmatter } from "./frontmatter";

/**
 * Projection version. 2: workspace-wide wiki resolution; a stored version
 * mismatch forces one full projection on the first sync after upgrade.
 */
const VERSION = 2;
const EDGE_TYPE = /^[a-z][a-z0-9_]*$/;
const RELATIVE_REF = /^\.\.?\//;
type ProjectionError = { relPath: string; code: string; message: string };

function identity(doc: DocumentRow): GraphReferenceDocument {
  return {
    documentId: doc.id,
    collection: doc.collection,
    relPath: doc.relPath,
    docid: doc.docid,
    uri: doc.uri,
    title: doc.title,
    mirrorHash: doc.mirrorHash,
    sourceHash: doc.sourceHash,
    contentType: doc.contentType ?? null,
  };
}

/**
 * Insert once in catalog order: preserves legacy Array.find ambiguity precedence.
 * Plain wiki-style targets from a document inside a link workspace use the
 * shared workspace ranking (a tie resolves to nothing); URIs, docids,
 * collection-qualified paths and relative markdown keep their contracts.
 */
function relationResolver(
  docs: GraphReferenceDocument[],
  memberships: ReturnType<typeof membershipsFromCollectionRows>
) {
  const workspace = createInMemoryWorkspaceResolver(
    memberships,
    docs.map((doc) => ({
      id: doc.documentId,
      docid: doc.docid,
      collection: doc.collection,
      relPath: doc.relPath,
      title: doc.title,
    }))
  );
  const byId = new Map(docs.map((doc) => [doc.documentId, doc]));
  const docids = new Map<string, GraphReferenceDocument>();
  const uris = new Map<string, GraphReferenceDocument>();
  const paths = new Map<string, GraphReferenceDocument>();
  const wiki = new Map<string, GraphReferenceDocument>();
  const localWiki = new Map<string, GraphReferenceDocument>();
  const put = (
    map: Map<string, GraphReferenceDocument>,
    key: string,
    doc: GraphReferenceDocument
  ) => {
    if (!map.has(key)) map.set(key, doc);
  };
  for (const doc of docs) {
    put(docids, doc.docid, doc);
    put(uris, doc.uri, doc);
    put(paths, `${doc.collection}/${doc.relPath}`, doc);
    const title = doc.title ?? doc.relPath.split("/").pop() ?? doc.relPath;
    for (const value of [
      title,
      doc.relPath,
      doc.relPath.replace(/\.[^/.]+$/, ""),
    ]) {
      const key = normalizeWikiName(value);
      put(wiki, key, doc);
      put(localWiki, `${doc.collection}\0${key}`, doc);
    }
  }
  return (
    source: GraphReferenceDocument,
    raw: string
  ): GraphReferenceDocument | undefined => {
    const target = normalizeRelationTarget(raw);
    if (!target) return;
    if (target.startsWith("#")) return docids.get(target);
    if (target.startsWith("gno://")) return uris.get(target);
    const parts = parseTargetParts(target);
    if (!parts.ref) return;
    const key = normalizeWikiName(parts.ref);
    if (parts.collection)
      return (
        paths.get(`${parts.collection}/${parts.ref}`) ??
        localWiki.get(`${parts.collection}\0${key}`)
      );
    const relativePath = normalizeMarkdownPath(parts.ref, source.relPath);
    const relativeHit = relativePath
      ? paths.get(`${source.collection}/${relativePath}`)
      : undefined;
    const ranked = workspace(source, key);
    if (ranked === undefined) {
      // Source outside any link workspace: the collection-scoped contract.
      return (
        relativeHit ??
        paths.get(parts.ref) ??
        localWiki.get(`${source.collection}\0${key}`) ??
        wiki.get(key)
      );
    }
    // Inside a workspace only the preserved contracts bypass the shared
    // ranking: a collection-qualified path (`collection/relPath`) and an
    // explicitly relative Markdown path (`./x.md`, `../x.md`). Every other
    // name or path resolves exactly as the shared link resolver does.
    const qualified = paths.get(parts.ref);
    if (qualified) return qualified;
    if (RELATIVE_REF.test(parts.ref) && relativeHit) return relativeHit;
    return ranked?.traversable ? byId.get(ranked.target.id) : undefined;
  };
}

export async function projectGraph(
  store: StorePort,
  options: SyncOptions,
  requestedSources?: Set<number>,
  forceFull = false
): Promise<ProjectionError[]> {
  const errors: ProjectionError[] = [];
  try {
    const graph = store.graphReferenceStore?.();
    let fingerprint = "";
    // Partial ports (tests, adapters without collections) resolve links
    // collection-scoped; the SQLite store always reports memberships.
    const collections =
      typeof store.getCollections === "function"
        ? await store.getCollections()
        : undefined;
    if (collections && !collections.ok)
      throw new Error(collections.error.message);
    const memberships = membershipsFromCollectionRows(collections?.value ?? []);
    if (graph) {
      if (!collections) throw new Error("Graph projection needs collections");
      // Effective workspace membership (roots, nested vaults, real paths) is
      // part of each collection row, so a membership change re-projects.
      fingerprint = new Bun.CryptoHasher("sha256")
        .update(
          JSON.stringify({
            resolver: LINK_RESOLVER_VERSION,
            rules: options.contentTypeRules ?? [],
            collections: collections.value
              .map(({ syncedAt: _syncedAt, ...config }) => config)
              .sort((a, b) => a.name.localeCompare(b.name)),
          })
        )
        .digest("hex");
    }
    const state = graph?.state(VERSION, fingerprint);
    if (!forceFull && state?.complete) return [];
    const documents = await store.listDocuments();
    if (!documents.ok) throw new Error(documents.error.message);
    const activeDocs = documents.value.filter((doc) => doc.active);
    const current = activeDocs.map(identity);
    const currentById = new Map(current.map((doc) => [doc.documentId, doc]));
    // Read before begin: a new version/config deliberately resets the old inventory.
    const previous = graph?.readInventory() ?? [];
    const previousById = new Map(
      previous.map((row) => [row.document.documentId, row])
    );
    const full =
      forceFull ||
      !graph ||
      !state ||
      state.inProgress ||
      state.version !== VERSION ||
      state.configFingerprint !== fingerprint;
    // An existing graph whose resolver or collection membership changed is
    // rebuilt in full; report it so the fallback is never silent.
    if (!forceFull && state && state.version !== null) {
      if (state.version !== VERSION)
        options.onGraphRebuild?.("resolver-upgrade");
      else if (state.configFingerprint !== fingerprint)
        options.onGraphRebuild?.("collections-changed");
    }
    const resolve = relationResolver(current, memberships);
    let selected: Set<number> | undefined;
    if (!full && graph) {
      selected = new Set(requestedSources);
      const changed = new Map<number, GraphReferenceDocument[]>();
      for (const doc of current) {
        const old = previousById.get(doc.documentId)?.document;
        if (!old || JSON.stringify(old) !== JSON.stringify(doc)) {
          changed.set(doc.documentId, old ? [old, doc] : [doc]);
          selected.add(doc.documentId);
        }
      }
      for (const row of previous) {
        if (!currentById.has(row.document.documentId)) {
          changed.set(row.document.documentId, [row.document]);
          selected.add(row.document.documentId);
        }
      }
      // Input mutation without a changed identity can be a direct parsed-link edit.
      // No durable per-source link journal exists; conservatively rebuild in that case.
      if (changed.size === 0 && state.dirty) selected = undefined;
      else {
        for (const id of graph.incomingLinkSources(
          [...changed.values()].flat()
        ))
          selected.add(id);
        const resolveOld = relationResolver(
          previous.map((row) => row.document),
          memberships
        );
        for (const row of previous) {
          const source = currentById.get(row.document.documentId);
          if (!source || selected.has(source.documentId)) continue;
          if (
            row.references.some(
              (ref) =>
                resolveOld(row.document, ref.target)?.documentId !==
                resolve(source, ref.target)?.documentId
            )
          )
            selected.add(source.documentId);
        }
      }
    }
    // Persist interruption authority before starting the projection transaction.
    const epoch = graph?.begin(VERSION, fingerprint);
    if (state && epoch !== state.epoch + 1)
      throw new Error("Graph inputs changed while computing affected sources");
    const work = async () => {
      const targets = selected
        ? documents.value.filter((doc) => selected.has(doc.id))
        : documents.value;
      // Configured sources get their final sets below. Applying defaults first
      // would delete/recreate an unchanged configured edge on every repair pass.
      const defaults = targets.filter((doc) => {
        const hint = options.contentTypeRules?.find(
          (rule) => rule.id === doc.contentType
        )?.graphHints?.[0];
        return !doc.active || !hint || !EDGE_TYPE.test(hint);
      });
      const backfill = await store.backfillDocEdges(
        defaults.map((doc) => doc.id)
      );
      if (!backfill.ok) throw new Error(backfill.error.message);
      for (const [index, doc] of targets.entries()) {
        if (index > 0 && index % 25 === 0) await Bun.sleep(0);
        if (!doc.active) {
          const cleared = await store.setDocEdges(
            doc.id,
            [],
            "frontmatter-relation"
          );
          if (!cleared.ok)
            errors.push({ relPath: doc.relPath, ...cleared.error });
          continue;
        }
        const snapshot = currentById.get(doc.id)!;
        const cached = selected ? previousById.get(doc.id) : undefined;
        let references: GraphReferenceInventory["references"];
        if (
          cached &&
          cached.document.mirrorHash === doc.mirrorHash &&
          cached.document.sourceHash === doc.sourceHash
        )
          references = cached.references;
        else {
          references = [];
          if (doc.mirrorHash) {
            const content = await store.getContent(doc.mirrorHash);
            if (!content.ok || content.value === null) {
              errors.push({
                relPath: doc.relPath,
                code: "QUERY_FAILED",
                message: content.ok
                  ? "Missing graph source content"
                  : content.error.message,
              });
              continue;
            }
            const relations = parseFrontmatter(content.value).metadata
              .relations;
            if (isRelationMap(relations)) {
              for (const [rawType, refs] of Object.entries(relations)) {
                const edgeType = normalizeRelationEdgeType(rawType);
                if (EDGE_TYPE.test(edgeType)) {
                  for (const target of refs)
                    references.push({ edgeType, target });
                }
              }
            }
          }
        }
        const relationEdges: DocEdgeInput[] = [];
        for (const ref of references) {
          const target = resolve(snapshot, ref.target);
          if (target)
            relationEdges.push({
              targetDocId: target.documentId,
              edgeType: ref.edgeType,
              confidence: "manual",
            });
        }
        const relationsResult = await store.setDocEdges(
          doc.id,
          relationEdges,
          "frontmatter-relation"
        );
        if (!relationsResult.ok)
          errors.push({ relPath: doc.relPath, ...relationsResult.error });
        graph?.writeInventory({ document: snapshot, references });
        const hint = options.contentTypeRules?.find(
          (rule) => rule.id === doc.contentType
        )?.graphHints?.[0];
        if (!hint || !EDGE_TYPE.test(hint)) continue;
        const links = await store.getLinksForDoc(doc.id);
        if (!links.ok) {
          errors.push({ relPath: doc.relPath, ...links.error });
          continue;
        }
        const relationIds = new Set(
          relationEdges.map((edge) => edge.targetDocId)
        );
        const wikiEdges: DocEdgeInput[] = [];
        const markdownEdges: DocEdgeInput[] = [];
        for (const link of links.value) {
          const ref =
            link.linkType === "markdown"
              ? `${doc.collection}/${link.targetRefNorm}`
              : link.targetCollection
                ? `${link.targetCollection}:${link.targetRef}`
                : link.targetRefNorm;
          const target = resolve(snapshot, ref);
          if (!target || relationIds.has(target.documentId)) continue;
          const edge: DocEdgeInput = {
            targetDocId: target.documentId,
            edgeType: hint,
            confidence: "configured",
          };
          (link.linkType === "wiki" ? wikiEdges : markdownEdges).push(edge);
        }
        for (const [source, edges] of [
          ["wikilink", wikiEdges],
          ["markdown-link", markdownEdges],
        ] as const) {
          const result = await store.setDocEdges(doc.id, edges, source);
          if (!result.ok)
            errors.push({ relPath: doc.relPath, ...result.error });
        }
      }
      if (errors.length) throw new Error("Graph projection incomplete");
      if (graph && epoch !== undefined) graph.complete(epoch);
    };
    if (store.withTransaction) {
      const result = await store.withTransaction(work);
      if (!result.ok && errors.length === 0)
        throw new Error(result.error.message);
    } else await work();
  } catch (cause) {
    if (errors.length === 0)
      errors.push({
        relPath: "(typed edge projection)",
        code: "QUERY_FAILED",
        message:
          cause instanceof Error ? cause.message : "Graph projection failed",
      });
  }
  return errors;
}
