import { describe, expect, test } from "bun:test";

import {
  loadFavoriteCollections,
  loadFavoriteDocuments,
  loadRecentDocuments,
  saveRecentDocument,
  toggleFavoriteCollection,
  toggleFavoriteDocument,
  type NavigationStorageLike,
} from "../../../src/serve/public/lib/navigation-state";

function createStorage(): NavigationStorageLike {
  const data = new Map<string, string>();
  return {
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
  };
}

describe("navigation state", () => {
  test("recent docs dedupe and cap", () => {
    const storage = createStorage();

    saveRecentDocument(
      { uri: "gno://notes/a.md", href: "/doc?uri=a", label: "A" },
      storage
    );
    saveRecentDocument(
      { uri: "gno://notes/b.md", href: "/doc?uri=b", label: "B" },
      storage
    );
    saveRecentDocument(
      { uri: "gno://notes/a.md", href: "/doc?uri=a", label: "A" },
      storage
    );

    expect(loadRecentDocuments(storage)).toEqual([
      { uri: "gno://notes/a.md", href: "/doc?uri=a", label: "A" },
      { uri: "gno://notes/b.md", href: "/doc?uri=b", label: "B" },
    ]);
  });

  test("favorite docs toggle on and off", () => {
    const storage = createStorage();

    const first = toggleFavoriteDocument(
      { uri: "gno://notes/a.md", href: "/doc?uri=a", label: "A" },
      storage
    );
    expect(first).toHaveLength(1);
    expect(loadFavoriteDocuments(storage)).toHaveLength(1);

    const second = toggleFavoriteDocument(
      { uri: "gno://notes/a.md", href: "/doc?uri=a", label: "A" },
      storage
    );
    expect(second).toHaveLength(0);
    expect(loadFavoriteDocuments(storage)).toHaveLength(0);
  });

  test("favorite collections toggle on and off", () => {
    const storage = createStorage();

    const first = toggleFavoriteCollection(
      {
        name: "notes",
        href: "/browse?collection=notes",
        label: "notes",
      },
      storage
    );
    expect(first).toHaveLength(1);
    expect(loadFavoriteCollections(storage)).toHaveLength(1);

    const second = toggleFavoriteCollection(
      {
        name: "notes",
        href: "/browse?collection=notes",
        label: "notes",
      },
      storage
    );
    expect(second).toHaveLength(0);
    expect(loadFavoriteCollections(storage)).toHaveLength(0);
  });
});
