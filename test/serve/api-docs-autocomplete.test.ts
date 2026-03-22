import { describe, expect, test } from "bun:test";

import type { DocumentRow } from "../../src/store/types";

import { handleDocsAutocomplete } from "../../src/serve/routes/api";

function createMockStore(docs: DocumentRow[]) {
  return {
    listDocuments(collection?: string) {
      return Promise.resolve({
        ok: true as const,
        value: collection
          ? docs.filter((doc) => doc.collection === collection)
          : docs,
      });
    },
  };
}

function createDoc(
  overrides: Partial<DocumentRow> & {
    docid: string;
    uri: string;
    relPath: string;
  }
): DocumentRow {
  const { docid, uri, relPath, ...rest } = overrides;
  return {
    id: 1,
    collection: "notes",
    relPath,
    sourceHash: "hash",
    sourceMime: "text/markdown",
    sourceExt: ".md",
    sourceSize: 100,
    sourceMtime: new Date().toISOString(),
    docid,
    uri,
    title: overrides.title ?? null,
    mirrorHash: "mirror",
    converterId: null,
    converterVersion: null,
    languageHint: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastErrorAt: null,
    active: true,
    ingestVersion: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...rest,
  };
}

describe("GET /api/docs/autocomplete", () => {
  test("filters documents by title or path", async () => {
    const store = createMockStore([
      createDoc({
        docid: "#auth123",
        uri: "gno://notes/auth-flow.md",
        relPath: "auth-flow.md",
        title: "Auth Flow",
      }),
      createDoc({
        docid: "#design123",
        uri: "gno://notes/design.md",
        relPath: "design.md",
        title: "Design Notes",
      }),
    ]);

    const url = new URL("http://localhost/api/docs/autocomplete?query=auth");
    const res = await handleDocsAutocomplete(store as never, url);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      docs: Array<{ title: string; uri: string }>;
    };
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0]?.title).toBe("Auth Flow");
  });
});
