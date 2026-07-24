/**
 * Canonical identity helpers for persisted context records.
 *
 * @module src/core/context-identity
 */

const BYTE_ORDER_MARK_PATTERN = /^\uFEFF/u;
const CARRIAGE_RETURN_PATTERN = /\r\n?/g;

export function normalizePersistedContextText(text: string): string {
  return text
    .replace(BYTE_ORDER_MARK_PATTERN, "")
    .replace(CARRIAGE_RETURN_PATTERN, "\n")
    .normalize("NFC")
    .trim();
}
