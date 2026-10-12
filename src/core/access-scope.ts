/**
 * Collection access for gateway principals (opt-in).
 *
 * A request is in access mode when a named, non-admin gateway principal made
 * it. Such a request may read only collections whose `access` rule admits
 * its subject and conversation context; a collection without `access` is
 * denied. Requests without a principal (stdio, `gno serve`, a plain
 * `tokenFile` caller) and admin principals are unrestricted, so nothing
 * changes unless `gateway.principals` is configured.
 *
 * `accessRef` collections stay denied unless `gateway.accessHook` is set and
 * the hook allows the collection's ref for this request (see
 * `access-hook.ts`); that keeps the rule fail-closed.
 *
 * @module src/core/access-scope
 */

import type { Collection, CollectionAccess } from "../config/types";
import type { MetadataPredicate, TypedMetadata } from "./typed-metadata";

export type AccessContext = "1to1" | "shared" | "public_only";

/** The parts of the request snapshot access decisions read. */
export interface AccessRequest {
  principal?: { admin: boolean };
  subject?: { id: string; context?: AccessContext; requestId?: string };
}

/** One error for missing, unreadable and unauthorized targets alike. */
export const ACCESS_NOT_FOUND_MESSAGE = "NOT_FOUND: Not found";

export const accessNotFound = (): Error => new Error(ACCESS_NOT_FOUND_MESSAGE);

/** Typed-metadata key that carries a document's sources. */
export const DERIVED_FROM_KEY = "derived_from";

/** `<sys>:<ref>`: same system tag shape as `access.accessRef.sys`. */
const DERIVED_FROM_MEMBER = /^[a-z][a-z0-9_-]{0,31}:\S/;

export const isAccessMode = (request: AccessRequest): boolean =>
  request.principal !== undefined && !request.principal.admin;

/** A missing subject or context is treated as `public_only`. */
const effectiveContext = (request: AccessRequest): AccessContext =>
  request.subject?.context ?? "public_only";

/** Whether one access rule admits this request. */
export const accessRuleAdmits = (
  access: CollectionAccess | undefined,
  request: AccessRequest
): boolean => {
  if (access === undefined) return false;
  if ("public" in access) return true;
  const context = effectiveContext(request);
  if ("owner" in access) {
    return context === "1to1" && request.subject?.id === access.owner;
  }
  // accessRef (firm-wide or not) needs the access hook to check the subject
  // against the referenced source; the static rule alone denies it.
  return false;
};

/**
 * `accessRef` collections the access hook may admit for this request: any in
 * a 1:1 conversation, only `firmwide` ones in a shared conversation, none for
 * `public_only` or outside access mode. The hook still decides each one.
 */
export const hookCheckedAccessRefCollections = <
  T extends Pick<Collection, "name" | "access">,
>(
  collections: readonly T[],
  request: AccessRequest
): T[] => {
  if (!isAccessMode(request)) return [];
  const context = effectiveContext(request);
  return collections.filter((collection) => {
    const access = collection.access;
    if (!access || !("accessRef" in access)) return false;
    if (context === "1to1") return true;
    return context === "shared" && access.firmwide === true;
  });
};

/** Provenance key of a collection: `access.provenanceKey` or `derived_from`. */
export const provenanceKeyOf = (access: CollectionAccess | undefined): string =>
  access?.provenanceKey ?? DERIVED_FROM_KEY;

/**
 * Whether this request may write into the collection (memory writes): only
 * an `owner` collection, for its owner, in a 1:1 conversation.
 */
export const accessRuleAdmitsWrite = (
  access: CollectionAccess | undefined,
  request: AccessRequest
): boolean =>
  access !== undefined &&
  "owner" in access &&
  accessRuleAdmits(access, request);

/**
 * Collection names this request may read, in config order, or `undefined`
 * when the request is not in access mode (no restriction).
 */
export const authorizedCollectionNames = (
  collections: readonly Pick<Collection, "name" | "access">[],
  request: AccessRequest
): string[] | undefined => {
  if (!isAccessMode(request)) return undefined;
  return collections
    .filter((collection) => accessRuleAdmits(collection.access, request))
    .map((collection) => collection.name);
};

/**
 * Why a document's `derived_from` is not servable, or null when it is: a
 * non-empty array of `<sys>:<ref>` strings.
 */
export const derivedFromIssue = (
  metadata: TypedMetadata | null | undefined,
  metadataError?: string | null,
  key: string = DERIVED_FROM_KEY
): "missing" | "invalid" | null => {
  if (metadataError) return "invalid";
  if (!metadata || !Object.hasOwn(metadata, key)) return "missing";
  const value = metadata[key];
  if (!Array.isArray(value) || value.length === 0) return "invalid";
  return value.every(
    (member) => typeof member === "string" && DERIVED_FROM_MEMBER.test(member)
  )
    ? null
    : "invalid";
};

/** Pre-limit predicate: only documents that declare `derived_from`. */
export const DERIVED_FROM_PRESENT: MetadataPredicate = {
  op: "exists",
  key: DERIVED_FROM_KEY,
  value: true,
};

/**
 * AND the caller's filter with the provenance presence requirement. With
 * several provenance keys in scope any one must be present; the per-collection
 * key is then enforced by the retrieval allowlist.
 */
export const withDerivedFromRequired = (
  filter: unknown,
  keys: readonly string[] = [DERIVED_FROM_KEY]
): unknown => {
  const unique = keys.length > 0 ? [...new Set(keys)] : [DERIVED_FROM_KEY];
  const present: MetadataPredicate =
    unique.length === 1 && unique[0] === DERIVED_FROM_KEY
      ? DERIVED_FROM_PRESENT
      : unique.length === 1
        ? { op: "exists", key: unique[0]!, value: true }
        : {
            op: "or",
            predicates: unique.map((key) => ({
              op: "exists" as const,
              key,
              value: true,
            })),
          };
  return filter === undefined
    ? present
    : { op: "and", predicates: [filter, present] };
};
