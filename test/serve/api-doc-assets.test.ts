import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { DocumentRow } from "../../src/store/types";

import { handleDocAsset } from "../../src/serve/routes/api";
import { safeRm } from "../helpers/cleanup";

function createConfig(root: string): Config {
  return {
    version: "1.0",
    ftsTokenizer: "unicode61",
    collections: [
      {
        name: "reading",
        path: root,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ],
    contexts: [],
  };
}

function createDoc(relPath: string): DocumentRow {
  return {
    id: 1,
    collection: "reading",
    relPath,
    sourceHash: "hash",
    sourceMime: "text/markdown",
    sourceExt: ".md",
    sourceSize: 100,
    sourceMtime: new Date().toISOString(),
    docid: "#doc",
    uri: "gno://reading/Build%20a%20Large%20Language%20Model%20(Raschka)/source/04-implementing-gpt.md",
    title: "04-implementing-gpt",
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
  };
}

describe("doc asset API", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-doc-asset-"));
  });

  afterEach(async () => {
    await safeRm(tmpDir);
  });

  test("serves note-relative image assets", async () => {
    const relPath =
      "Build a Large Language Model (Raschka)/source/04-implementing-gpt.md";
    const doc = createDoc(relPath);
    const sourceDir = join(
      tmpDir,
      "Build a Large Language Model (Raschka)",
      "source"
    );
    const imagesDir = join(sourceDir, "Images");

    await mkdir(imagesDir, { recursive: true });
    await writeFile(join(sourceDir, "04-implementing-gpt.md"), "# chapter");
    await writeFile(join(imagesDir, "4-1.png"), "png-bytes");

    const store = {
      getDocumentByUri(uri: string) {
        return Promise.resolve({
          ok: true as const,
          value: uri === doc.uri ? doc : null,
        });
      },
    };

    const res = await handleDocAsset(
      store as never,
      createConfig(tmpDir),
      new URL(
        `http://localhost/api/doc-asset?uri=${encodeURIComponent(doc.uri)}&path=${encodeURIComponent("Images/4-1.png")}`
      )
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("png-bytes");
  });

  test("blocks relative asset traversal outside collection root", async () => {
    const relPath =
      "Build a Large Language Model (Raschka)/source/04-implementing-gpt.md";
    const doc = createDoc(relPath);

    const store = {
      getDocumentByUri(uri: string) {
        return Promise.resolve({
          ok: true as const,
          value: uri === doc.uri ? doc : null,
        });
      },
    };

    const res = await handleDocAsset(
      store as never,
      createConfig(tmpDir),
      new URL(
        `http://localhost/api/doc-asset?uri=${encodeURIComponent(doc.uri)}&path=${encodeURIComponent("../../../../../../etc/passwd")}`
      )
    );

    expect(res.status).toBe(403);
  });
});
