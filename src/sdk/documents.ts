/**
 * SDK document retrieval helpers.
 *
 * @module src/sdk/documents
 */

import { minimatch } from "minimatch";

import type { GetResponse } from "../cli/commands/get";
import type { LsResponse } from "../cli/commands/ls";
import type {
  MultiGetDocument,
  MultiGetResponse,
  SkippedDoc,
} from "../cli/commands/multi-get";
import type { ParsedRef } from "../cli/commands/ref-parser";
import type { Config } from "../config/types";
import type { DocumentRow, StorePort } from "../store/types";
import type {
  GnoGetOptions,
  GnoListOptions,
  GnoMultiGetOptions,
} from "./types";

import { isGlobPattern, parseRef, splitRefs } from "../cli/commands/ref-parser";
import { getDocumentCapabilities } from "../core/document-capabilities";
import { sdkError } from "./errors";

const URI_PREFIX_PATTERN = /^gno:\/\/[^/]+\//;
const encoder = new TextEncoder();

function lookupDocument(store: StorePort, parsed: ParsedRef) {
  switch (parsed.type) {
    case "docid":
      return store.getDocumentByDocid(parsed.value);
    case "uri":
      return store.getDocumentByUri(parsed.value);
    case "collPath":
      if (!(parsed.collection && parsed.relPath)) {
        return Promise.resolve({ ok: true as const, value: null });
      }
      return store.getDocument(parsed.collection, parsed.relPath);
  }
}

function buildSourceMeta(
  doc: DocumentRow,
  config: Config
): GetResponse["source"] {
  const coll = config.collections.find((c) => c.name === doc.collection);
  return {
    absPath: coll ? `${coll.path}/${doc.relPath}` : undefined,
    relPath: doc.relPath,
    mime: doc.sourceMime,
    ext: doc.sourceExt,
    sizeBytes: doc.sourceSize,
    modifiedAt: doc.sourceMtime ?? undefined,
    sourceHash: doc.sourceHash,
  };
}

function buildConversionMeta(
  doc: DocumentRow
): GetResponse["conversion"] | undefined {
  if (!doc.converterId) {
    return;
  }
  return {
    converterId: doc.converterId ?? undefined,
    converterVersion: doc.converterVersion ?? undefined,
    mirrorHash: doc.mirrorHash ?? undefined,
  };
}

export async function getDocumentByRef(
  store: StorePort,
  config: Config,
  ref: string,
  options: GnoGetOptions = {}
): Promise<GetResponse> {
  if (options.from !== undefined && options.from <= 0) {
    throw sdkError("VALIDATION", "--from must be a positive integer");
  }
  if (options.limit !== undefined && options.limit < 0) {
    throw sdkError("VALIDATION", "limit cannot be negative");
  }

  const parsed = parseRef(ref);
  if ("error" in parsed) {
    throw sdkError("VALIDATION", parsed.error);
  }

  const docResult = await lookupDocument(store, parsed);
  if (!docResult.ok) {
    throw sdkError("STORE", docResult.error.message, {
      cause: docResult.error.cause,
    });
  }

  const doc = docResult.value;
  if (!doc?.active) {
    throw sdkError("NOT_FOUND", "Document not found");
  }
  if (!doc.mirrorHash) {
    throw sdkError("RUNTIME", "Mirror content unavailable (conversion error)");
  }

  const contentResult = await store.getContent(doc.mirrorHash);
  if (!contentResult.ok || contentResult.value === null) {
    throw sdkError("RUNTIME", "Mirror content unavailable", {
      cause: !contentResult.ok ? contentResult.error.cause : undefined,
    });
  }

  const lines = contentResult.value.split("\n");
  const totalLines = lines.length;
  if (options.limit === 0) {
    return {
      docid: doc.docid,
      uri: doc.uri,
      title: doc.title ?? undefined,
      content: "",
      totalLines,
      language: doc.languageHint ?? undefined,
      source: buildSourceMeta(doc, config),
      conversion: buildConversionMeta(doc),
      capabilities: getDocumentCapabilities({
        sourceExt: doc.sourceExt,
        sourceMime: doc.sourceMime,
        contentAvailable: doc.mirrorHash !== null,
      }),
    };
  }

  const startLine = options.from ?? parsed.line ?? 1;
  const limit = options.limit ?? totalLines;
  const clampedStart = Math.max(1, Math.min(startLine, totalLines));
  const clampedEnd = Math.min(clampedStart + limit - 1, totalLines);
  const selectedLines = lines.slice(clampedStart - 1, clampedEnd);
  const isPartial = clampedStart > 1 || clampedEnd < totalLines;

  return {
    docid: doc.docid,
    uri: doc.uri,
    title: doc.title ?? undefined,
    content: selectedLines.join("\n"),
    totalLines,
    returnedLines: isPartial
      ? { start: clampedStart, end: clampedEnd }
      : undefined,
    language: doc.languageHint ?? undefined,
    source: buildSourceMeta(doc, config),
    conversion: buildConversionMeta(doc),
    capabilities: getDocumentCapabilities({
      sourceExt: doc.sourceExt,
      sourceMime: doc.sourceMime,
      contentAvailable: doc.mirrorHash !== null,
    }),
  };
}

function truncateContent(
  content: string,
  maxBytes: number
): { content: string; truncated: boolean } {
  if (encoder.encode(content).length <= maxBytes) {
    return { content, truncated: false };
  }

  const lines = content.split("\n");
  let accumulated = "";
  let byteLen = 0;
  for (const line of lines) {
    const lineBytes = encoder.encode(`${line}\n`).length;
    if (byteLen + lineBytes > maxBytes) {
      return { content: accumulated.trimEnd(), truncated: true };
    }
    accumulated += `${line}\n`;
    byteLen += lineBytes;
  }

  return { content: accumulated.trimEnd(), truncated: false };
}

async function expandGlobs(
  refs: string[],
  store: StorePort
): Promise<{ expanded: string[]; invalidRefs: string[] }> {
  const expanded: string[] = [];
  const invalidRefs: string[] = [];

  for (const ref of refs) {
    if (!isGlobPattern(ref)) {
      expanded.push(ref);
      continue;
    }

    const slashIdx = ref.indexOf("/");
    if (slashIdx === -1) {
      invalidRefs.push(ref);
      continue;
    }

    const collection = ref.slice(0, slashIdx);
    const pattern = ref.slice(slashIdx + 1);
    const listResult = await store.listDocuments(collection);
    if (!listResult.ok) {
      invalidRefs.push(ref);
      continue;
    }

    for (const doc of listResult.value) {
      if (doc.active && minimatch(doc.relPath, pattern)) {
        expanded.push(`${collection}/${doc.relPath}`);
      }
    }
  }

  return { expanded, invalidRefs };
}

export async function multiGetDocuments(
  store: StorePort,
  config: Config,
  refs: string[],
  options: GnoMultiGetOptions = {}
): Promise<MultiGetResponse> {
  const maxBytes = options.maxBytes ?? 10_240;
  const allRefs = splitRefs(refs);
  const { expanded, invalidRefs } = await expandGlobs(allRefs, store);

  const documents: MultiGetDocument[] = [];
  const skipped: SkippedDoc[] = invalidRefs.map((ref) => ({
    ref,
    reason: "invalid_ref",
  }));
  const seen = new Set<string>();

  for (const ref of expanded) {
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);

    const parsed = parseRef(ref);
    if ("error" in parsed) {
      skipped.push({ ref, reason: "invalid_ref" });
      continue;
    }

    const docResult = await lookupDocument(store, parsed);
    if (!docResult.ok || !docResult.value?.active) {
      skipped.push({ ref, reason: "not_found" });
      continue;
    }

    const doc = docResult.value;
    if (!doc.mirrorHash) {
      skipped.push({ ref, reason: "conversion_error" });
      continue;
    }

    const contentResult = await store.getContent(doc.mirrorHash);
    if (!contentResult.ok || contentResult.value === null) {
      skipped.push({ ref, reason: "conversion_error" });
      continue;
    }

    const { content, truncated } = truncateContent(
      contentResult.value,
      maxBytes
    );
    const coll = config.collections.find((c) => c.name === doc.collection);
    documents.push({
      docid: doc.docid,
      uri: doc.uri,
      title: doc.title ?? undefined,
      content,
      truncated: truncated || undefined,
      totalLines: content.split("\n").length,
      source: {
        absPath: coll ? `${coll.path}/${doc.relPath}` : undefined,
        relPath: doc.relPath,
        mime: doc.sourceMime,
        ext: doc.sourceExt,
      },
    });
  }

  return {
    documents,
    skipped,
    meta: {
      requested: expanded.length + invalidRefs.length,
      returned: documents.length,
      skipped: skipped.length,
      maxBytes,
    },
  };
}

export async function listDocuments(
  store: StorePort,
  options: GnoListOptions = {}
): Promise<LsResponse> {
  const scope = options.scope;
  if (scope?.startsWith("gno://")) {
    if (scope === "gno://") {
      throw sdkError("VALIDATION", "Invalid scope: missing collection");
    }
    if (!URI_PREFIX_PATTERN.test(scope)) {
      throw sdkError(
        "VALIDATION",
        "Invalid scope: missing trailing path (use gno://collection/)"
      );
    }
  }

  const docsResult = !scope
    ? await store.listDocuments()
    : scope.startsWith("gno://")
      ? await store.listDocuments()
      : await store.listDocuments(scope);

  if (!docsResult.ok) {
    throw sdkError("STORE", docsResult.error.message, {
      cause: docsResult.error.cause,
    });
  }

  const allActive = docsResult.value
    .filter((d) => d.active)
    .filter((d) =>
      !scope?.startsWith("gno://") ? true : d.uri.startsWith(scope)
    )
    .map((d) => ({
      docid: d.docid,
      uri: d.uri,
      title: d.title ?? undefined,
      source: {
        relPath: d.relPath,
        mime: d.sourceMime,
        ext: d.sourceExt,
      },
    }))
    .sort((a, b) => a.uri.localeCompare(b.uri));

  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  const paged = allActive.slice(offset, offset + limit);

  return {
    documents: paged,
    meta: {
      total: allActive.length,
      returned: paged.length,
      offset,
    },
  };
}
