/**
 * Access hook client (opt-in, `gateway.accessHook`).
 *
 * In access mode (a non-admin gateway principal, see `access-scope.ts`) GNO
 * asks an external hook which opaque `{sys, ref}` sources the request's
 * subject may read. GNO never interprets a ref; it only serves a document
 * when the hook allows every ref in its provenance key (`derived_from` by
 * default) and an `accessRef` collection when the hook allows its ref.
 *
 * Wire: `POST {subject, ctx, request_id, refs: [{sys, ref}]}` ->
 * `200 {allow: [index]}`. Fail closed: an index the hook does not list, a
 * late answer, a non-200 status, malformed JSON or a transport error denies.
 *
 * Concurrency: at most `maxConcurrent` hook calls (default 16) are in flight
 * per hook; the rest queue in order. A call's deadline starts when it is
 * sent, so queueing never turns into a timeout denial. The MCP layer awaits
 * hook calls with the tool mutex released (`waitOutside`), so one slow hook
 * answer does not hold other callers' tool calls.
 *
 * @module src/core/access-hook
 */

import type { HttpGatewayAccessHook } from "../config/types";
import type { TypedMetadata } from "./typed-metadata";

import { type AccessContext, DERIVED_FROM_KEY } from "./access-scope";

export const DEFAULT_ACCESS_HOOK_TIMEOUT_MS = 2000;
export const DEFAULT_ACCESS_HOOK_MAX_CONCURRENT = 16;

/** One opaque source reference, as sent to the hook. */
export interface AccessRef {
  sys: string;
  ref: string;
}

export interface AccessHookRequest {
  subject: string;
  ctx: AccessContext;
  request_id: string;
  refs: AccessRef[];
}

/** The document fields a per-document access check reads. */
export interface AccessCheckedDocument {
  id: number;
  collection: string;
  typedMetadata?: TypedMetadata | null;
  metadataError?: string | null;
}

/**
 * Per-request document check: resolves to the ids of the documents that may
 * be served. Retrieval drops every other document before graph expansion,
 * reranking, assembly and counts.
 */
export type DocumentAccessCheck = (
  documents: readonly AccessCheckedDocument[]
) => Promise<ReadonlySet<number>>;

/** `<sys>:<ref>`, the same system tag shape as `access.accessRef.sys`. */
const REF_MEMBER = /^([a-z][a-z0-9_-]{0,31}):(\S.*)$/s;

/** `<sys>:<ref>` string -> `{sys, ref}`, or null when malformed. */
export const parseAccessRef = (member: unknown): AccessRef | null => {
  if (typeof member !== "string") return null;
  const match = REF_MEMBER.exec(member);
  return match ? { sys: match[1]!, ref: match[2]! } : null;
};

export const accessRefKey = (ref: AccessRef): string => `${ref.sys}:${ref.ref}`;

/**
 * A document's sources under `key`, or null when it has none or any member is
 * malformed (not servable in access mode).
 */
export const provenanceRefs = (
  metadata: TypedMetadata | null | undefined,
  metadataError: string | null | undefined,
  key: string = DERIVED_FROM_KEY
): AccessRef[] | null => {
  if (metadataError || !metadata || !Object.hasOwn(metadata, key)) return null;
  const value = metadata[key];
  if (!Array.isArray(value) || value.length === 0) return null;
  const refs: AccessRef[] = [];
  for (const member of value) {
    const ref = parseAccessRef(member);
    if (!ref) return null;
    refs.push(ref);
  }
  return refs;
};

export type AccessHookFetch = (
  url: string,
  init: RequestInit & { unix?: string }
) => Promise<Response>;

/** First-in, first-out bound on the hook calls in flight. */
class HookCallLimiter {
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(readonly max: number) {}

  /** Number of calls currently sent and not yet answered (for tests). */
  get active(): number {
    return this.#active;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active < this.max) this.#active += 1;
    // A released slot passes straight to the next waiter (no decrement).
    else await new Promise<void>((resolve) => this.#queue.push(resolve));
    try {
      return await operation();
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#active -= 1;
    }
  }
}

/** One limiter per hook endpoint and bound, shared by every request. */
const limiters = new Map<string, HookCallLimiter>();

const limiterFor = (hook: HttpGatewayAccessHook): HookCallLimiter => {
  const max = hook.maxConcurrent ?? DEFAULT_ACCESS_HOOK_MAX_CONCURRENT;
  const key = JSON.stringify([hook.url, hook.unix ?? null, max]);
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = new HookCallLimiter(max);
    limiters.set(key, limiter);
  }
  return limiter;
};

/**
 * One hook call. Resolves to one boolean per ref (true = allowed); never
 * rejects, every failure denies all refs. Waits for a slot under the hook's
 * `maxConcurrent` bound first; the deadline covers only the exchange.
 */
export function callAccessHook(
  hook: HttpGatewayAccessHook,
  request: AccessHookRequest,
  fetchImpl: AccessHookFetch = fetch as AccessHookFetch
): Promise<boolean[]> {
  const denied = request.refs.map(() => false);
  if (request.refs.length === 0) return Promise.resolve(denied);
  return limiterFor(hook).run(() =>
    exchangeWithHook(hook, request, fetchImpl, denied)
  );
}

async function exchangeWithHook(
  hook: HttpGatewayAccessHook,
  request: AccessHookRequest,
  fetchImpl: AccessHookFetch,
  denied: boolean[]
): Promise<boolean[]> {
  const timeoutMs = hook.timeoutMs ?? DEFAULT_ACCESS_HOOK_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  const exchange = (async (): Promise<unknown> => {
    const response = await fetchImpl(hook.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
      redirect: "error",
      ...(hook.unix ? { unix: hook.unix } : {}),
    });
    if (response.status !== 200) return null;
    return response.json();
  })().catch(() => null);
  try {
    const body = await Promise.race([exchange, deadline]);
    if (!body || typeof body !== "object") return denied;
    const allow = (body as { allow?: unknown }).allow;
    if (!Array.isArray(allow)) return denied;
    const result = [...denied];
    for (const index of allow) {
      if (
        typeof index === "number" &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < result.length
      ) {
        result[index] = true;
      }
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Refs checked within one request; each distinct ref is asked once. */
export interface AccessHookSession {
  /** The subset of `refs` (by `sys:ref` key) the hook allows. */
  allowed(refs: readonly AccessRef[]): Promise<ReadonlySet<string>>;
  /** Number of hook calls made so far (for `explain` and tests). */
  readonly calls: number;
}

export interface AccessHookSessionOptions {
  /**
   * Runs around each hook wait. The MCP layer passes `yieldToolMutex` so a
   * request awaits its hook answer without holding the tool mutex.
   */
  waitOutside?: <T>(wait: () => Promise<T>) => Promise<T>;
}

export function createAccessHookSession(
  hook: HttpGatewayAccessHook,
  identity: { subject: string; ctx: AccessContext; requestId: string },
  fetchImpl?: AccessHookFetch,
  options: AccessHookSessionOptions = {}
): AccessHookSession {
  const waitOutside =
    options.waitOutside ?? (<T>(wait: () => Promise<T>) => wait());
  const decided = new Map<string, boolean>();
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async allowed(refs) {
      const pending = new Map<string, AccessRef>();
      for (const ref of refs) {
        const key = accessRefKey(ref);
        if (!decided.has(key)) pending.set(key, ref);
      }
      if (pending.size > 0) {
        const batch = [...pending.values()];
        calls += 1;
        const verdicts = await waitOutside(() =>
          callAccessHook(
            hook,
            {
              subject: identity.subject,
              ctx: identity.ctx,
              request_id: identity.requestId,
              refs: batch,
            },
            fetchImpl
          )
        );
        batch.forEach((ref, index) =>
          decided.set(accessRefKey(ref), verdicts[index] === true)
        );
      }
      const allowed = new Set<string>();
      for (const ref of refs) {
        const key = accessRefKey(ref);
        if (decided.get(key) === true) allowed.add(key);
      }
      return allowed;
    },
  };
}

/**
 * Build the per-document check: a document passes only when its collection
 * is readable and the hook allows every ref under its collection's
 * provenance key. One batched hook call per invocation (cached refs skip it).
 */
export function createDocumentAccessCheck(options: {
  session: AccessHookSession;
  canRead: (collection: string) => boolean;
  provenanceKeyOf: (collection: string) => string;
}): DocumentAccessCheck {
  return async (documents) => {
    const wanted: { id: number; refs: AccessRef[] }[] = [];
    const all: AccessRef[] = [];
    for (const doc of documents) {
      if (!options.canRead(doc.collection)) continue;
      const refs = provenanceRefs(
        doc.typedMetadata,
        doc.metadataError,
        options.provenanceKeyOf(doc.collection)
      );
      if (!refs) continue;
      wanted.push({ id: doc.id, refs });
      all.push(...refs);
    }
    const allowedRefs = await options.session.allowed(all);
    const allowed = new Set<number>();
    for (const doc of wanted) {
      if (doc.refs.every((ref) => allowedRefs.has(accessRefKey(ref)))) {
        allowed.add(doc.id);
      }
    }
    return allowed;
  };
}
