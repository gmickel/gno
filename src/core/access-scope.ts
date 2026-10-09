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
 * `accessRef` collections stay denied until an access hook can check them;
 * that keeps the rule fail-closed.
 *
 * @module src/core/access-scope
 */

import type { Collection, CollectionAccess } from "../config/types";
import type { MetadataPredicate, TypedMetadata } from "./typed-metadata";

export type AccessContext = "1to1" | "shared" | "public_only";

/** The parts of the request snapshot access decisions read. */
export interface AccessRequest {
  principal?: { admin: boolean };
  subject?: { id: string; context?: AccessContext };
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
  // against the referenced source. No hook exists yet, so it is denied.
  return false;
};

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
  metadataError?: string | null
): "missing" | "invalid" | null => {
  if (metadataError) return "invalid";
  if (!metadata || !Object.hasOwn(metadata, DERIVED_FROM_KEY)) return "missing";
  const value = metadata[DERIVED_FROM_KEY];
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

/** AND the caller's filter with the `derived_from` presence requirement. */
export const withDerivedFromRequired = (filter: unknown): unknown =>
  filter === undefined
    ? DERIVED_FROM_PRESENT
    : { op: "and", predicates: [filter, DERIVED_FROM_PRESENT] };
