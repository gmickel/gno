/**
 * One request ID per submitted write intent.
 *
 * Retrying the same payload (after a lost response or an error) reuses the
 * ID, so the server replays the committed outcome instead of writing twice.
 * A changed payload is a new intent and gets a new ID.
 */
export interface RequestIntent {
  key: string;
  requestId: string;
}

export function requestIdForIntent(
  slot: { current: RequestIntent | null },
  key: string
): string {
  if (slot.current?.key !== key) {
    slot.current = { key, requestId: crypto.randomUUID() };
  }
  return slot.current.requestId;
}
