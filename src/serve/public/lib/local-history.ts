export interface LocalHistoryEntry {
  savedAt: string;
  content: string;
}

const HISTORY_PREFIX = "gno.doc-history.";
const MAX_ENTRIES = 10;

function getHistoryKey(docId: string): string {
  return `${HISTORY_PREFIX}${docId}`;
}

export function loadLocalHistory(docId: string): LocalHistoryEntry[] {
  try {
    const raw = localStorage.getItem(getHistoryKey(docId));
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

export function appendLocalHistory(docId: string, content: string): void {
  const next = [
    { savedAt: new Date().toISOString(), content },
    ...loadLocalHistory(docId).filter((entry) => entry.content !== content),
  ].slice(0, MAX_ENTRIES);
  localStorage.setItem(getHistoryKey(docId), JSON.stringify(next));
}

export function loadLatestLocalHistory(
  docId: string
): LocalHistoryEntry | undefined {
  return loadLocalHistory(docId)[0];
}
