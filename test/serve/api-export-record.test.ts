import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { ContextHolder } from "../../src/serve/routes/api";
import type { DocumentRow } from "../../src/store/types";

import { handleDoc, handleUpdateDoc } from "../../src/serve/routes/api";
import { safeRm } from "../helpers/cleanup";

const HASH = "a".repeat(64);
const FINGERPRINT = "b".repeat(64);

const exportRecord = (): DocumentRow => ({
  id: 1,
  collection: "exports",
  relPath: `.gno/records/container/${HASH}.md`,
  sourceHash: HASH,
  sourceMime: "text/vtt",
  sourceExt: ".vtt",
  sourceSize: 120,
  sourceMtime: "2026-07-25T08:00:00.000Z",
  docid: "#record1",
  uri: `gno://exports/.gno/records/container/${HASH}.md`,
  title: "Ada at 00:01",
  mirrorHash: "mirror-record",
  converterId: "adapter/transcript",
  converterVersion: "1.0.0",
  languageHint: "en",
  recordKey: HASH,
  recordSourcePath: "meeting.vtt",
  recordSourceLocator: "lines:1-3",
  recordMetadata: {
    author: "Ada",
    participants: ["Ada"],
    sessionId: "session-7",
  },
  recordAnchors: [
    { kind: "timestamp", value: "00:01.000", endValue: "00:03.000" },
  ],
  recordAdapterFingerprint: FINGERPRINT,
  lastErrorCode: null,
  lastErrorMessage: null,
  lastErrorAt: null,
  active: true,
  ingestVersion: 1,
  createdAt: "2026-07-25T08:00:00.000Z",
  updatedAt: "2026-07-25T08:00:00.000Z",
});

const configFor = (root: string): Config => ({
  version: "1.0",
  ftsTokenizer: "unicode61",
  collections: [
    {
      name: "exports",
      path: root,
      pattern: "**/*",
      include: [],
      exclude: [],
    },
  ],
  contexts: [],
});

const storeFor = (doc: DocumentRow) => ({
  getDocumentByDocid(docid: string) {
    return Promise.resolve({
      ok: true as const,
      value: docid === doc.docid ? doc : null,
    });
  },
  getDocumentByUri(uri: string) {
    return Promise.resolve({
      ok: true as const,
      value: uri === doc.uri ? doc : null,
    });
  },
  getContent(mirrorHash: string) {
    return Promise.resolve({
      ok: true as const,
      value: mirrorHash === doc.mirrorHash ? "# Ada\n\nDecision" : null,
    });
  },
  getTagsForDoc() {
    return Promise.resolve({ ok: true as const, value: [] });
  },
});

describe("Serve logical export records", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-serve-export-record-"));
  });

  afterEach(async () => {
    await safeRm(root);
  });

  test("GET projects the real source and complete record provenance", async () => {
    const doc = exportRecord();
    const response = await handleDoc(
      storeFor(doc) as never,
      configFor(root),
      new URL(`http://localhost/api/doc?uri=${encodeURIComponent(doc.uri)}`)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      relPath: string;
      source: {
        absPath?: string;
        relPath: string;
        mime: string;
        ext: string;
      };
      record: Record<string, unknown>;
      capabilities: { editable: boolean; mode: string };
    };
    expect(body.relPath).toBe("meeting.vtt");
    expect(body.source).toMatchObject({
      absPath: join(root, "meeting.vtt"),
      relPath: "meeting.vtt",
      mime: "text/vtt",
      ext: ".vtt",
    });
    expect(body.record).toEqual({
      recordKey: HASH,
      sourceLocator: "lines:1-3",
      anchors: [
        {
          kind: "timestamp",
          value: "00:01.000",
          endValue: "00:03.000",
        },
      ],
      adapter: {
        id: "adapter/transcript",
        version: "1.0.0",
        fingerprint: FINGERPRINT,
      },
      author: "Ada",
      participants: ["Ada"],
      sessionId: "session-7",
    });
    expect(body.capabilities).toMatchObject({
      editable: false,
      mode: "read_only",
    });
  });

  test("PUT rejects in-place edits before touching the virtual path", async () => {
    const doc = exportRecord();
    const config = configFor(root);
    const holder = {
      current: { config },
      config,
      scheduler: null,
      eventBus: null,
      watchService: null,
    } as ContextHolder;
    const response = await handleUpdateDoc(
      holder,
      storeFor(doc) as never,
      doc.docid,
      new Request("http://localhost/api/docs/record1", {
        method: "PUT",
        body: JSON.stringify({
          content: "attempted overwrite",
          uri: doc.uri,
        }),
      }),
      { lockPath: join(root, ".mcp-write.lock") }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "READ_ONLY" },
    });
  });
});
