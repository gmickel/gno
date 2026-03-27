export interface LocalHistoryEntry {
  savedAt: string;
  content: string;
}

export interface LocalHistoryStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const HISTORY_PREFIX = "gno.doc-history.";
const MAX_ENTRIES = 10;

function getHistoryKey(docId: string): string {
  return `${HISTORY_PREFIX}${docId}`;
}

function getStorage(
  storage?: LocalHistoryStorageLike
): LocalHistoryStorageLike | null {
  if (storage) {
    return storage;
  }
  if (typeof localStorage === "undefined") {
    return null;
  }
  return localStorage;
}

export function loadLocalHistory(
  docId: string,
  storage?: LocalHistoryStorageLike
): LocalHistoryEntry[] {
  try {
    const resolved = getStorage(storage);
    if (!resolved) return [];
    const raw = resolved.getItem(getHistoryKey(docId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is LocalHistoryEntry => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as Record<string, unknown>;
      return (
        typeof candidate.savedAt === "string" &&
        typeof candidate.content === "string"
      );
    });
  } catch {
    return [];
  }
}

export function appendLocalHistory(
  docId: string,
  content: string,
  storage?: LocalHistoryStorageLike
): void {
  const resolved = getStorage(storage);
  if (!resolved) {
    return;
  }
  const next = [
    { savedAt: new Date().toISOString(), content },
    ...loadLocalHistory(docId, storage).filter(
      (entry) => entry.content !== content
    ),
  ].slice(0, MAX_ENTRIES);
  resolved.setItem(getHistoryKey(docId), JSON.stringify(next));
}

export function loadLatestLocalHistory(
  docId: string,
  storage?: LocalHistoryStorageLike
): LocalHistoryEntry | undefined {
  return loadLocalHistory(docId, storage)[0];
}
