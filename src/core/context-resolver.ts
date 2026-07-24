import type { ContextRow, StorePort } from "../store/types";

import { parseUri } from "../app/constants";
import { normalizePersistedContextText } from "./context-identity";

export interface ContextDocumentIdentity {
  collection: string;
  relPath: string;
}

export interface ContextProvenance {
  scopeType: ContextRow["scopeType"];
  scopeKey: string;
  normalizedScopeKey: string;
  text: string;
  syncedAt: string;
}

export interface ResolvedContext {
  /** Backward-compatible context value exposed on retrieval results. */
  text: string;
  /** Ordered source records used to assemble `text`. */
  provenance: ContextProvenance[];
}

interface NormalizedIdentity {
  collection: string;
  relPath: string;
}

interface MatchingContext extends ContextProvenance {
  depth: number;
}

interface ContextSnapshot {
  generation: number;
  contexts: ContextRow[];
}

function normalizeRelativePath(path: string): string | null {
  if (path.includes("\0")) {
    return null;
  }

  const normalizedSeparators = path.replaceAll("\\", "/");
  if (normalizedSeparators.startsWith("/")) {
    return null;
  }

  const segments: string[] = [];
  for (const segment of normalizedSeparators.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function normalizeIdentity(
  identity: ContextDocumentIdentity
): NormalizedIdentity | null {
  const collection = identity.collection.trim();
  const relPath = normalizeRelativePath(identity.relPath);
  if (!collection || collection.includes("/") || relPath === null) {
    return null;
  }
  return { collection, relPath };
}

function byteKey(text: string): string {
  return [...new TextEncoder().encode(text)].join(",");
}

function matchesPathPrefix(relPath: string, prefix: string): boolean {
  return (
    prefix === "" || relPath === prefix || relPath.startsWith(`${prefix}/`)
  );
}

function normalizeContext(
  context: ContextRow,
  identity: NormalizedIdentity
): MatchingContext | null {
  const text = normalizePersistedContextText(context.text);
  if (!text) {
    return null;
  }

  if (context.scopeType === "global") {
    if (context.scopeKey !== "/") {
      return null;
    }
    return {
      ...context,
      normalizedScopeKey: "/",
      text,
      depth: 0,
    };
  }

  if (context.scopeType === "collection") {
    const collection = context.scopeKey.endsWith(":")
      ? context.scopeKey.slice(0, -1)
      : "";
    if (!collection || collection !== identity.collection) {
      return null;
    }
    return {
      ...context,
      normalizedScopeKey: `${collection}:`,
      text,
      depth: 0,
    };
  }

  const parsed = parseUri(context.scopeKey);
  if (!parsed || parsed.collection !== identity.collection) {
    return null;
  }
  const prefix = normalizeRelativePath(parsed.path);
  if (prefix === null || !matchesPathPrefix(identity.relPath, prefix)) {
    return null;
  }

  return {
    ...context,
    normalizedScopeKey: `gno://${parsed.collection}/${prefix}`,
    text,
    depth: prefix ? prefix.split("/").length : 0,
  };
}

function compareMatchingContexts(
  left: MatchingContext,
  right: MatchingContext
): number {
  const typeOrder = { global: 0, collection: 1, prefix: 2 } as const;
  const typeDifference = typeOrder[left.scopeType] - typeOrder[right.scopeType];
  if (typeDifference !== 0) {
    return typeDifference;
  }
  if (left.depth !== right.depth) {
    return left.depth - right.depth;
  }
  const scopeDifference = left.normalizedScopeKey.localeCompare(
    right.normalizedScopeKey
  );
  if (scopeDifference !== 0) {
    return scopeDifference;
  }
  const sourceDifference = left.scopeKey.localeCompare(right.scopeKey);
  return sourceDifference !== 0
    ? sourceDifference
    : byteKey(left.text).localeCompare(byteKey(right.text));
}

/** Resolve a context snapshot against one canonical collection-relative identity. */
export function resolveContextSnapshot(
  contexts: ContextRow[],
  identity: ContextDocumentIdentity
): ResolvedContext | undefined {
  const normalizedIdentity = normalizeIdentity(identity);
  if (!normalizedIdentity) {
    return;
  }

  const matching = contexts
    .map((context) => normalizeContext(context, normalizedIdentity))
    .filter((context): context is MatchingContext => context !== null)
    .sort(compareMatchingContexts);

  const seenRecords = new Set<string>();
  const seenTexts = new Set<string>();
  const provenance: ContextProvenance[] = [];
  const joinedTexts: string[] = [];

  for (const context of matching) {
    const textKey = byteKey(context.text);
    const recordKey = `${context.scopeType}\0${context.normalizedScopeKey}\0${textKey}`;
    if (seenRecords.has(recordKey)) {
      continue;
    }
    seenRecords.add(recordKey);
    provenance.push({
      scopeType: context.scopeType,
      scopeKey: context.scopeKey,
      normalizedScopeKey: context.normalizedScopeKey,
      text: context.text,
      syncedAt: context.syncedAt,
    });
    if (!seenTexts.has(textKey)) {
      seenTexts.add(textKey);
      joinedTexts.push(context.text);
    }
  }

  if (provenance.length === 0) {
    return;
  }
  return { text: joinedTexts.join("\n\n"), provenance };
}

export function contextIdentityFromUri(
  uri: string
): ContextDocumentIdentity | null {
  const parsed = parseUri(uri);
  if (!parsed) {
    return null;
  }
  const identity = normalizeIdentity({
    collection: parsed.collection,
    relPath: parsed.path,
  });
  return identity ? { ...identity } : null;
}

/**
 * Request-local resolver backed by one store snapshot per context generation.
 * Failed context reads degrade to no context and are retried without retaining
 * the previous generation, so retrieval never receives stale guidance.
 */
export class ContextResolver {
  private snapshot?: ContextSnapshot;

  constructor(private readonly store: StorePort) {}

  async resolve(
    identity: ContextDocumentIdentity
  ): Promise<ResolvedContext | undefined> {
    const [resolved] = await this.resolveMany([identity]);
    return resolved;
  }

  async resolveUri(uri: string): Promise<ResolvedContext | undefined> {
    const identity = contextIdentityFromUri(uri);
    return identity ? this.resolve(identity) : undefined;
  }

  async resolveMany(
    identities: ContextDocumentIdentity[]
  ): Promise<Array<ResolvedContext | undefined>> {
    if (identities.length === 0) {
      return [];
    }
    const contexts = await this.loadCurrentContexts();
    return identities.map((identity) =>
      resolveContextSnapshot(contexts, identity)
    );
  }

  private async loadCurrentContexts(): Promise<ContextRow[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const generation = this.store.getContextGeneration();
      if (this.snapshot?.generation === generation) {
        return this.snapshot.contexts;
      }

      this.snapshot = undefined;
      const contextsResult = await this.store.getContexts();
      if (!contextsResult.ok) {
        return [];
      }

      if (this.store.getContextGeneration() === generation) {
        this.snapshot = { generation, contexts: contextsResult.value };
        return this.snapshot.contexts;
      }
    }
    return [];
  }
}
