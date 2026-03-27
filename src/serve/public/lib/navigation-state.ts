export interface RecentDoc {
  uri: string;
  href: string;
  label: string;
}

export interface FavoriteDoc {
  uri: string;
  href: string;
  label: string;
}

export interface FavoriteCollection {
  name: string;
  href: string;
  label: string;
}

export interface NavigationStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const RECENT_DOCS_STORAGE_KEY = "gno.recent-docs";
export const FAVORITE_DOCS_STORAGE_KEY = "gno.favorite-docs";
export const FAVORITE_COLLECTIONS_STORAGE_KEY = "gno.favorite-collections";

function getStorage(
  storage?: NavigationStorageLike
): NavigationStorageLike | null {
  if (storage) {
    return storage;
  }
  if (typeof localStorage === "undefined") {
    return null;
  }
  return localStorage;
}

function loadList<T>(
  key: string,
  isValid: (value: unknown) => value is T,
  storage?: NavigationStorageLike
): T[] {
  try {
    const resolved = getStorage(storage);
    if (!resolved) {
      return [];
    }
    const raw = resolved.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isValid);
  } catch {
    return [];
  }
}

function saveList<T>(
  key: string,
  value: T[],
  storage?: NavigationStorageLike
): void {
  const resolved = getStorage(storage);
  if (!resolved) {
    return;
  }
  resolved.setItem(key, JSON.stringify(value));
}

function isRecentDoc(value: unknown): value is RecentDoc {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.uri === "string" &&
    typeof candidate.href === "string" &&
    typeof candidate.label === "string"
  );
}

function isFavoriteCollection(value: unknown): value is FavoriteCollection {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.href === "string" &&
    typeof candidate.label === "string"
  );
}

export function loadRecentDocuments(
  storage?: NavigationStorageLike
): RecentDoc[] {
  return loadList(RECENT_DOCS_STORAGE_KEY, isRecentDoc, storage);
}

export function saveRecentDocument(
  doc: RecentDoc,
  storage?: NavigationStorageLike
): void {
  const current = loadRecentDocuments(storage).filter(
    (entry) => entry.href !== doc.href
  );
  saveList(RECENT_DOCS_STORAGE_KEY, [doc, ...current].slice(0, 8), storage);
}

export function loadFavoriteDocuments(
  storage?: NavigationStorageLike
): FavoriteDoc[] {
  return loadList(FAVORITE_DOCS_STORAGE_KEY, isRecentDoc, storage);
}

export function toggleFavoriteDocument(
  doc: FavoriteDoc,
  storage?: NavigationStorageLike
): FavoriteDoc[] {
  const current = loadFavoriteDocuments(storage);
  const exists = current.some((entry) => entry.href === doc.href);
  const next = exists
    ? current.filter((entry) => entry.href !== doc.href)
    : [doc, ...current].slice(0, 12);
  saveList(FAVORITE_DOCS_STORAGE_KEY, next, storage);
  return next;
}

export function loadFavoriteCollections(
  storage?: NavigationStorageLike
): FavoriteCollection[] {
  return loadList(
    FAVORITE_COLLECTIONS_STORAGE_KEY,
    isFavoriteCollection,
    storage
  );
}

export function toggleFavoriteCollection(
  collection: FavoriteCollection,
  storage?: NavigationStorageLike
): FavoriteCollection[] {
  const current = loadFavoriteCollections(storage);
  const exists = current.some((entry) => entry.name === collection.name);
  const next = exists
    ? current.filter((entry) => entry.name !== collection.name)
    : [collection, ...current].slice(0, 12);
  saveList(FAVORITE_COLLECTIONS_STORAGE_KEY, next, storage);
  return next;
}
