/**
 * Privacy-safe, bounded encoding of SectionTargetV1 for additive URL params.
 * Private helper — import public API from `./sections`.
 *
 * Human-readable `#anchor` fragments stay unchanged. The optional `st`
 * query param carries a versioned, size-bounded target for citation-safe
 * recovery. It must never embed a full section body.
 *
 * @module src/core/section-target-link
 */

import {
  isBoundedSectionTarget,
  SECTION_TARGET_BOUNDS,
  type SectionTargetV1,
} from "./section-target";
import { parseSectionTargetV1 } from "./section-target-transport";

/** Query parameter name for the additive durable selector. */
export const SECTION_TARGET_LINK_PARAM = "st" as const;

/** Version prefix for the encoded selector payload. */
export const SECTION_TARGET_LINK_VERSION = "1" as const;

/**
 * Hard cap on the encoded `st` value (version prefix + base64url payload).
 * Keeps citation links shareable in local tooling without giant URLs.
 */
export const SECTION_TARGET_LINK_MAX_ENCODED_CHARS = 3072 as const;

const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const base64UrlToBytes = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    return null;
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const base64 = padded + "=".repeat(padLength);
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
};

/**
 * Encode a bounded SectionTargetV1 as `1.<base64url(json)>`.
 * Returns null when the target is unbounded or the encoded form exceeds
 * {@link SECTION_TARGET_LINK_MAX_ENCODED_CHARS}.
 */
export function encodeSectionTargetLinkParam(
  target: SectionTargetV1
): string | null {
  if (!isBoundedSectionTarget(target)) {
    return null;
  }
  const json = JSON.stringify(target);
  if (UTF8.encode(json).byteLength > SECTION_TARGET_BOUNDS.maxSerializedBytes) {
    return null;
  }
  const encoded = `${SECTION_TARGET_LINK_VERSION}.${bytesToBase64Url(UTF8.encode(json))}`;
  if (encoded.length > SECTION_TARGET_LINK_MAX_ENCODED_CHARS) {
    return null;
  }
  return encoded;
}

/**
 * Decode an `st` query value into a validated SectionTargetV1.
 * Fail-closed: malformed version, padding, JSON, or bounds → null.
 * Error paths never echo quote/body text.
 */
export function decodeSectionTargetLinkParam(
  value: string
): SectionTargetV1 | null {
  if (
    value.length < 3 ||
    value.length > SECTION_TARGET_LINK_MAX_ENCODED_CHARS
  ) {
    return null;
  }
  const dot = value.indexOf(".");
  if (dot < 1) {
    return null;
  }
  const version = value.slice(0, dot);
  const payload = value.slice(dot + 1);
  if (version !== SECTION_TARGET_LINK_VERSION || payload.length < 1) {
    return null;
  }
  const bytes = base64UrlToBytes(payload);
  if (!bytes || bytes.byteLength > SECTION_TARGET_BOUNDS.maxSerializedBytes) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch {
    return null;
  }
  const validated = parseSectionTargetV1(parsed);
  if (!validated.ok) {
    return null;
  }
  return validated.value;
}

/** Stable, content-free reason codes for link decode failures. */
export type SectionTargetLinkDecodeFailure =
  | "missing"
  | "malformed"
  | "unsupported_version"
  | "oversized";

/**
 * Classify why an `st` value could not be decoded without inspecting body text.
 */
export function classifySectionTargetLinkDecodeFailure(
  value: string | null | undefined
): SectionTargetLinkDecodeFailure {
  if (value === null || value === undefined || value.length < 1) {
    return "missing";
  }
  if (value.length > SECTION_TARGET_LINK_MAX_ENCODED_CHARS) {
    return "oversized";
  }
  const dot = value.indexOf(".");
  if (dot < 1) {
    return "malformed";
  }
  const version = value.slice(0, dot);
  if (version !== SECTION_TARGET_LINK_VERSION) {
    return "unsupported_version";
  }
  return "malformed";
}
