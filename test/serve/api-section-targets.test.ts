/**
 * REST section-target create/resolve + sections compatibility tests.
 */

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocumentInput, DocumentRow } from "../../src/store/types";

import createResultSchema from "../../spec/output-schemas/section-target-create-result.schema.json";
import resolveResultSchema from "../../spec/output-schemas/section-target-resolve-result.schema.json";
import targetSchema from "../../spec/output-schemas/section-target.schema.json";
import {
  CANONICAL_URI_EXCEEDS_TRANSPORT_BOUNDS,
  SECTION_TARGET_BOUNDS,
  type SectionTargetCreateResult,
  type SectionTargetResolveResult,
} from "../../src/core/sections";
import { handleDocSections } from "../../src/serve/routes/api";
import {
  handleCreateSectionTarget,
  handleResolveSectionTarget,
} from "../../src/serve/routes/section-targets";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";
import {
  SECTION_FIXTURE_CONTENT,
  SECTION_FIXTURE_URI,
  SECTION_SEMANTIC_CASES,
  captureFixtureTarget,
  wrongDocumentTarget,
} from "../helpers/section-target-fixtures";

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(targetSchema);
const validateCreate = ajv.compile(createResultSchema);
const validateResolve = ajv.compile(resolveResultSchema);

describe("REST section targets", () => {
  let tmpDir: string;
  let store: SqliteAdapter;
  let contentByHash: Map<string, string>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-section-targets-"));
    store = new SqliteAdapter();
    const opened = await store.open(join(tmpDir, "test.db"), "porter");
    expect(opened.ok).toBe(true);

    const sync = await store.syncCollections([
      {
        name: "notes",
        path: tmpDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ]);
    expect(sync.ok).toBe(true);

    contentByHash = new Map();
    const originalGetContent = store.getContent.bind(store);
    store.getContent = async (hash: string) => {
      const local = contentByHash.get(hash);
      if (local !== undefined) {
        return { ok: true as const, value: local };
      }
      return originalGetContent(hash);
    };
  });

  afterEach(async () => {
    await store.close();
    await safeRm(tmpDir);
  });

  async function upsertDoc(
    content: string,
    relPath = "pilot.md"
  ): Promise<{ docid: string; uri: string }> {
    const hash = `h-${Bun.hash(content).toString(16)}`;
    contentByHash.set(hash, content);
    const doc: DocumentInput = {
      collection: "notes",
      relPath,
      sourceHash: hash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: content.length,
      sourceMtime: new Date().toISOString(),
      title: "Pilot",
      mirrorHash: hash,
      ingestVersion: 2,
    };
    const result = await store.upsertDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("upsert failed");
    const loaded = await store.getDocumentByDocid(result.value.docid);
    expect(loaded.ok).toBe(true);
    expect(loaded.ok && loaded.value).toBeTruthy();
    if (!loaded.ok || !loaded.value) throw new Error("load failed");
    return { docid: loaded.value.docid, uri: loaded.value.uri };
  }

  test("GET /api/doc/:id/sections remains backward compatible", async () => {
    const doc = await upsertDoc(SECTION_FIXTURE_CONTENT);
    const res = await handleDocSections(store, doc.docid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sections: Array<{ anchor: string; line: number; title: string }>;
    };
    expect(body.sections.map((section) => section.anchor)).toEqual([
      "guide",
      "setup",
      "usage",
    ]);
    expect(Object.keys(body)).toEqual(["sections"]);
  });

  for (const fixture of SECTION_SEMANTIC_CASES) {
    test(`create+resolve ${fixture.id}`, async () => {
      const captureDoc = await upsertDoc(fixture.captureContent, "capture.md");
      const createRes = await handleCreateSectionTarget(
        store,
        captureDoc.docid,
        new Request("http://localhost/api/doc/x/section-targets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(fixture.selector),
        })
      );
      expect(createRes.status).toBe(200);
      const created = (await createRes.json()) as SectionTargetCreateResult;
      expect(validateCreate(created)).toBe(true);
      expect(created.uri).toBe(captureDoc.uri);
      expect(created.target.document.uri).toBe(captureDoc.uri);

      const resolveDoc = await upsertDoc(fixture.resolveContent, "resolve.md");
      // Retarget captured evidence to the resolve document URI for same-doc cases.
      const targetForResolve = {
        ...created.target,
        document: { uri: resolveDoc.uri },
      };

      const resolveRes = await handleResolveSectionTarget(
        store,
        resolveDoc.docid,
        new Request("http://localhost/api/doc/x/section-targets/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target: targetForResolve }),
        })
      );
      expect(resolveRes.status).toBe(200);
      const resolved = (await resolveRes.json()) as SectionTargetResolveResult;
      expect(validateResolve(resolved)).toBe(true);
      expect(resolved.status).toBe(fixture.expectedStatus);
      expect(resolved.uri).toBe(resolveDoc.uri);
      if (fixture.navigable) {
        expect(resolved.citation).toBeDefined();
        expect(resolved.citation?.uri).toBe(resolveDoc.uri);
      } else {
        expect(resolved.citation).toBeUndefined();
        expect("section" in resolved).toBe(false);
      }
    });
  }

  test("rejects invalid create selectors and oversized bodies", async () => {
    const doc = await upsertDoc(SECTION_FIXTURE_CONTENT);

    const both = await handleCreateSectionTarget(
      store,
      doc.docid,
      new Request("http://localhost/", {
        method: "POST",
        body: JSON.stringify({ anchor: "setup", line: 3 }),
      })
    );
    expect(both.status).toBe(400);

    const neither = await handleCreateSectionTarget(
      store,
      doc.docid,
      new Request("http://localhost/", {
        method: "POST",
        body: JSON.stringify({}),
      })
    );
    expect(neither.status).toBe(400);

    const oversized = await handleCreateSectionTarget(
      store,
      doc.docid,
      new Request("http://localhost/", {
        method: "POST",
        body: "x".repeat(2048),
      })
    );
    expect(oversized.status).toBe(400);
  });

  test("rejects malformed resolve targets and wrong-document targets", async () => {
    const doc = await upsertDoc(SECTION_FIXTURE_CONTENT);

    const malformed = await handleResolveSectionTarget(
      store,
      doc.docid,
      new Request("http://localhost/", {
        method: "POST",
        body: JSON.stringify({ target: { schemaVersion: "1" } }),
      })
    );
    expect(malformed.status).toBe(400);

    const wrong = await wrongDocumentTarget(SECTION_FIXTURE_CONTENT);
    const mismatch = await handleResolveSectionTarget(
      store,
      doc.docid,
      new Request("http://localhost/", {
        method: "POST",
        body: JSON.stringify({ target: wrong }),
      })
    );
    expect(mismatch.status).toBe(200);
    const body = (await mismatch.json()) as SectionTargetResolveResult;
    expect(validateResolve(body)).toBe(true);
    expect(body.status).toBe("missing");
    expect(body.diagnostics.reason).toBe("document_uri_mismatch");
    expect(body.citation).toBeUndefined();
    expect(body.uri).toBe(doc.uri);
  });

  test("create uses stored uri even when capture fixture uri differs", async () => {
    const doc = await upsertDoc(SECTION_FIXTURE_CONTENT);
    const res = await handleCreateSectionTarget(
      store,
      doc.docid,
      new Request("http://localhost/", {
        method: "POST",
        body: JSON.stringify({ anchor: "setup" }),
      })
    );
    const body = (await res.json()) as SectionTargetCreateResult;
    expect(body.uri).toBe(doc.uri);
    expect(body.target.document.uri).toBe(doc.uri);
    expect(body.uri).not.toBe(SECTION_FIXTURE_URI);

    const coreTarget = await captureFixtureTarget(SECTION_FIXTURE_CONTENT, {
      anchor: "setup",
    });
    expect(coreTarget.document.uri).toBe(SECTION_FIXTURE_URI);
  });

  test("rejects create/resolve when stored canonical URI exceeds transport bounds", async () => {
    const doc = await upsertDoc(SECTION_FIXTURE_CONTENT);
    const oversizedUri = `gno://notes/${"u".repeat(SECTION_TARGET_BOUNDS.uriMaxChars)}`;
    expect(oversizedUri.length).toBeGreaterThan(
      SECTION_TARGET_BOUNDS.uriMaxChars
    );

    const withOversizedUri = {
      getDocumentByDocid: async (docid: string) => {
        const result = await store.getDocumentByDocid(docid);
        if (!result.ok || !result.value) return result;
        return {
          ok: true as const,
          value: { ...result.value, uri: oversizedUri } satisfies DocumentRow,
        };
      },
      getDocumentByUri: store.getDocumentByUri.bind(store),
      getContent: store.getContent.bind(store),
    };

    const createRes = await handleCreateSectionTarget(
      withOversizedUri,
      doc.docid,
      new Request("http://localhost/", {
        method: "POST",
        body: JSON.stringify({ anchor: "setup" }),
      })
    );
    expect(createRes.status).toBe(422);
    const createBody = (await createRes.json()) as {
      error: { code: string; message: string };
    };
    expect(createBody.error.code).toBe("VALIDATION");
    expect(createBody.error.message).toBe(
      CANONICAL_URI_EXCEEDS_TRANSPORT_BOUNDS
    );
    expect(JSON.stringify(createBody)).not.toContain(oversizedUri);

    const target = await captureFixtureTarget(SECTION_FIXTURE_CONTENT, {
      anchor: "setup",
    });
    const resolveRes = await handleResolveSectionTarget(
      withOversizedUri,
      doc.docid,
      new Request("http://localhost/", {
        method: "POST",
        body: JSON.stringify({ target }),
      })
    );
    expect(resolveRes.status).toBe(422);
    const resolveBody = (await resolveRes.json()) as {
      error: { code: string; message: string };
    };
    expect(resolveBody.error.code).toBe("VALIDATION");
    expect(resolveBody.error.message).toBe(
      CANONICAL_URI_EXCEEDS_TRANSPORT_BOUNDS
    );
    expect(JSON.stringify(resolveBody)).not.toContain(oversizedUri);
  });
});
