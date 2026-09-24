/**
 * One request ID per submitted write intent.
 *
 * Retrying the same payload (after a lost response, an error, or a page
 * refresh) reuses the ID, so the server replays the committed outcome instead
 * of writing twice. A changed payload is a new intent and gets a new ID. The
 * unresolved intent is kept in sessionStorage so it survives a refresh of
 * this tab; it is cleared once the write is confirmed.
 */
export interface RequestIntent {
  key: string;
  requestId: string;
}

/** Compact payload fingerprint (cyrb53); a collision only yields a conflict error. */
function fingerprint(text: string): string {
  let h1 = 0xde_ad_be_ef;
  let h2 = 0x41_c6_ce_57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2_654_435_761);
    h2 = Math.imul(h2 ^ code, 1_597_334_677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
  return (4_294_967_296 * (2_097_151 & h2) + (h1 >>> 0)).toString(36);
}

function readStored(storageKey: string): RequestIntent | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as RequestIntent) : null;
  } catch {
    return null;
  }
}

export function requestIdForIntent(
  slot: { current: RequestIntent | null },
  payload: string,
  storageKey: string
): string {
  const key = fingerprint(payload);
  slot.current ??= readStored(storageKey);
  if (slot.current?.key !== key) {
    slot.current = { key, requestId: crypto.randomUUID() };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(slot.current));
    } catch {
      // Storage unavailable: the ID still covers retries in this page.
    }
  }
  return slot.current.requestId;
}

/** The intent's write is confirmed: the next submit is a new intent. */
export function clearRequestIntent(
  slot: { current: RequestIntent | null },
  storageKey: string
): void {
  slot.current = null;
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // Nothing persisted to clear.
  }
}
