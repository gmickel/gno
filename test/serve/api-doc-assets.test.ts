import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// node:url — platform-correct file URL encoding has no Bun equivalent.
import { pathToFileURL } from "node:url";

import type { Config } from "../../src/config/types";
import type { DocumentRow } from "../../src/store/types";

import {
  handlePdfjsAsset,
  isContainedInRoot,
  isSafePdfjsAssetFilename,
  pdfjsFileUrlToPath,
  PDFJS_ASSET_CACHE_CONTROL,
  PDFJS_CMAP_EXTENSIONS,
  PDFJS_STANDARD_FONT_EXTENSIONS,
  resolvePdfjsPackageRoot,
} from "../../src/serve/pdfjs-assets";
import {
  DOC_ASSET_CACHE_CONTROL,
  docAssetEtag,
  etagMatches,
  handleDocAsset,
  isPathWithinRoot,
} from "../../src/serve/routes/api";
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

/** Strong validator: quoted, never `W/`-prefixed. */
const STRONG_ETAG_RE = /^"[^"]+"$/u;

function assertDocAssetEnvelope(
  res: Response,
  opts: {
    status: number;
    hasBody: boolean;
    contentRange?: string | null;
  }
): void {
  expect(res.status).toBe(opts.status);
  expect(res.headers.get("accept-ranges")).toBe("bytes");
  expect(res.headers.get("cache-control")).toBe(DOC_ASSET_CACHE_CONTROL);
  expect(res.headers.get("content-disposition")).toContain("inline;");
  expect(res.headers.get("content-type")).toBeTruthy();
  expect(res.headers.get("etag")).toMatch(STRONG_ETAG_RE);
  if (opts.contentRange !== undefined) {
    expect(res.headers.get("content-range")).toBe(opts.contentRange);
  }
}

test("pdfjs file URLs decode spaces, percent escapes, and Unicode", () => {
  const decoded = join(tmpdir(), "GNO PDF", "漢字", "100%", "package.json");
  const encoded = pathToFileURL(decoded);
  expect(encoded.href).toContain("GNO%20PDF");
  expect(encoded.href).toContain("100%25");
  expect(pdfjsFileUrlToPath(encoded.href)).toBe(decoded);
  const plain = join(tmpdir(), "plain", "package.json");
  expect(pdfjsFileUrlToPath(plain)).toBe(plain);
});

async function setupSimpleAsset(
  tmpDir: string,
  body = "0123456789"
): Promise<{
  doc: DocumentRow;
  store: { getDocumentByUri: (uri: string) => Promise<unknown> };
  url: URL;
  body: string;
}> {
  const relPath = "notes/doc.md";
  const doc = createDoc(relPath);
  doc.uri = "gno://reading/notes/doc.md";
  const notesDir = join(tmpDir, "notes");
  await mkdir(notesDir, { recursive: true });
  await writeFile(join(notesDir, "doc.md"), "# note");
  await writeFile(join(notesDir, "asset.bin"), body);
  const store = {
    getDocumentByUri(uri: string) {
      return Promise.resolve({
        ok: true as const,
        value: uri === doc.uri ? doc : null,
      });
    },
  };
  const url = new URL(
    `http://localhost/api/doc-asset?uri=${encodeURIComponent(doc.uri)}&path=asset.bin`
  );
  return { doc, store, url, body };
}

describe("doc asset API", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-doc-asset-"));
  });

  afterEach(async () => {
    await safeRm(tmpDir);
  });

  test("serves note-relative image assets with Accept-Ranges and Content-Disposition", async () => {
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
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-disposition")).toContain("inline;");
    expect(res.headers.get("content-disposition")).toContain("4-1.png");
    expect(res.headers.get("cache-control")).toBe(DOC_ASSET_CACHE_CONTROL);
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

  test("rejects symlink that points outside collection root (realpath)", async () => {
    const relPath = "notes/doc.md";
    const doc = createDoc(relPath);
    doc.uri = "gno://reading/notes/doc.md";
    const notesDir = join(tmpDir, "notes");
    await mkdir(notesDir, { recursive: true });
    await writeFile(join(notesDir, "doc.md"), "# note");

    const outside = await mkdtemp(join(tmpdir(), "gno-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "TOP_SECRET");
      await symlink(join(outside, "secret.txt"), join(notesDir, "escape.txt"));

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
          `http://localhost/api/doc-asset?uri=${encodeURIComponent(doc.uri)}&path=${encodeURIComponent("escape.txt")}`
        )
      );
      expect(res.status).toBe(403);
    } finally {
      await safeRm(outside);
    }
  });

  test("non-ENOENT realpath errors fail closed (EACCES injection)", async () => {
    const root = join(tmpDir, "root");
    const candidate = join(root, "file.bin");
    await mkdir(root, { recursive: true });
    await writeFile(candidate, "data");

    const eaccess = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const eloop = Object.assign(new Error("too many links"), { code: "ELOOP" });

    const denyAcess = async (path: string): Promise<string> => {
      if (path === candidate) {
        throw eaccess;
      }
      return path;
    };
    const denyLoop = async (path: string): Promise<string> => {
      if (path === candidate) {
        throw eloop;
      }
      return path;
    };

    expect(await isPathWithinRoot(root, candidate, denyAcess)).toBe(false);
    expect(await isPathWithinRoot(root, candidate, denyLoop)).toBe(false);
    // ENOENT still falls back to lexical (true when lexically inside)
    const missing = join(root, "missing.bin");
    const enoent = async (path: string): Promise<string> => {
      if (path === missing) {
        throw Object.assign(new Error("noent"), { code: "ENOENT" });
      }
      return path;
    };
    expect(await isPathWithinRoot(root, missing, enoent)).toBe(true);
  });

  test("GET/HEAD matrix: full, exact, open, suffix, malformed, multiple, unsatisfiable", async () => {
    const { store, url, body } = await setupSimpleAsset(tmpDir);
    const config = createConfig(tmpDir);
    const total = body.length;

    const cases: Array<{
      name: string;
      method: "GET" | "HEAD";
      range?: string;
      status: number;
      contentRange?: string | null;
      bodyText?: string;
    }> = [
      {
        name: "GET full",
        method: "GET",
        status: 200,
        bodyText: body,
      },
      {
        name: "HEAD full",
        method: "HEAD",
        status: 200,
        bodyText: "",
      },
      {
        name: "GET exact range",
        method: "GET",
        range: "bytes=0-4",
        status: 206,
        contentRange: `bytes 0-4/${total}`,
        bodyText: "01234",
      },
      {
        name: "HEAD exact range",
        method: "HEAD",
        range: "bytes=0-4",
        status: 206,
        contentRange: `bytes 0-4/${total}`,
        bodyText: "",
      },
      {
        name: "GET open end",
        method: "GET",
        range: "bytes=5-",
        status: 206,
        contentRange: `bytes 5-9/${total}`,
        bodyText: "56789",
      },
      {
        name: "HEAD open end",
        method: "HEAD",
        range: "bytes=5-",
        status: 206,
        contentRange: `bytes 5-9/${total}`,
        bodyText: "",
      },
      {
        name: "GET suffix",
        method: "GET",
        range: "bytes=-3",
        status: 206,
        contentRange: `bytes 7-9/${total}`,
        bodyText: "789",
      },
      {
        name: "HEAD suffix",
        method: "HEAD",
        range: "bytes=-3",
        status: 206,
        contentRange: `bytes 7-9/${total}`,
        bodyText: "",
      },
      {
        name: "GET malformed",
        method: "GET",
        range: "bytes=abc",
        status: 416,
        contentRange: `bytes */${total}`,
        bodyText: "",
      },
      {
        name: "HEAD malformed",
        method: "HEAD",
        range: "bytes=abc",
        status: 416,
        contentRange: `bytes */${total}`,
        bodyText: "",
      },
      {
        name: "GET multi-range → 416",
        method: "GET",
        range: "bytes=0-1,2-3",
        status: 416,
        contentRange: `bytes */${total}`,
        bodyText: "",
      },
      {
        name: "HEAD multi-range → 416",
        method: "HEAD",
        range: "bytes=0-1,2-3",
        status: 416,
        contentRange: `bytes */${total}`,
        bodyText: "",
      },
      {
        name: "GET unsatisfiable",
        method: "GET",
        range: "bytes=100-200",
        status: 416,
        contentRange: `bytes */${total}`,
        bodyText: "",
      },
      {
        name: "HEAD unsatisfiable",
        method: "HEAD",
        range: "bytes=100-200",
        status: 416,
        contentRange: `bytes */${total}`,
        bodyText: "",
      },
    ];

    for (const c of cases) {
      const req = new Request("http://localhost/api/doc-asset", {
        method: c.method,
        headers: c.range ? { Range: c.range } : undefined,
      });
      const res = await handleDocAsset(store as never, config, url, req);
      assertDocAssetEnvelope(res, {
        status: c.status,
        hasBody: c.method === "GET" && c.status === 200,
        contentRange: c.contentRange,
      });
      const text = await res.text();
      expect(text).toBe(c.bodyText ?? "");
      if (c.method === "HEAD") {
        expect(text).toBe("");
      }
    }
  });

  test("GET vs HEAD header mirroring for 200/206/416 (excluding body-only headers)", async () => {
    const { store, url } = await setupSimpleAsset(tmpDir);
    const config = createConfig(tmpDir);

    const pairs: Array<{ range?: string }> = [
      {},
      { range: "bytes=0-3" },
      { range: "bytes=0-1,2-3" },
      { range: "bytes=abc" },
    ];

    for (const p of pairs) {
      const getReq = new Request("http://localhost/api/doc-asset", {
        method: "GET",
        headers: p.range ? { Range: p.range } : undefined,
      });
      const headReq = new Request("http://localhost/api/doc-asset", {
        method: "HEAD",
        headers: p.range ? { Range: p.range } : undefined,
      });
      const getRes = await handleDocAsset(store as never, config, url, getReq);
      const headRes = await handleDocAsset(
        store as never,
        config,
        url,
        headReq
      );
      expect(headRes.status).toBe(getRes.status);
      for (const h of [
        "accept-ranges",
        "cache-control",
        "content-disposition",
        "content-type",
        "content-range",
        "content-length",
        "etag",
      ]) {
        expect(headRes.headers.get(h)).toBe(getRes.headers.get(h));
      }
      expect(await headRes.text()).toBe("");
      // drain get body
      await getRes.arrayBuffer();
    }
  });

  test("Range bytes=0- image regression: 206 with full-length slice (MarkdownPreview)", async () => {
    const relPath = "notes/doc.md";
    const doc = createDoc(relPath);
    doc.uri = "gno://reading/notes/doc.md";
    const notesDir = join(tmpDir, "notes");
    await mkdir(notesDir, { recursive: true });
    await writeFile(join(notesDir, "doc.md"), "# note");
    const body = "png-image-bytes";
    await writeFile(join(notesDir, "img.png"), body);

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
        `http://localhost/api/doc-asset?uri=${encodeURIComponent(doc.uri)}&path=img.png`
      ),
      new Request("http://localhost/api/doc-asset", {
        headers: { Range: "bytes=0-" },
      })
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(
      `bytes 0-${body.length - 1}/${body.length}`
    );
    expect(res.headers.get("cache-control")).toBe(DOC_ASSET_CACHE_CONTROL);
    expect(await res.text()).toBe(body);
  });

  test("ETag is strong and derived from size + mtime; If-None-Match comparison is weak-tolerant", async () => {
    const { store, url, body } = await setupSimpleAsset(tmpDir);
    const config = createConfig(tmpDir);
    const res = await handleDocAsset(store as never, config, url);
    const etag = res.headers.get("etag");
    await res.arrayBuffer();
    expect(etag).toMatch(STRONG_ETAG_RE);
    expect(etag).toBe(
      docAssetEtag(Bun.file(join(tmpDir, "notes", "asset.bin")))
    );

    // A content change that alters the size yields a different validator.
    await writeFile(join(tmpDir, "notes", "asset.bin"), `${body}-grown`);
    const grown = await handleDocAsset(store as never, config, url);
    await grown.arrayBuffer();
    expect(grown.headers.get("etag")).not.toBe(etag);

    const current = grown.headers.get("etag") ?? "";
    const cases: Array<{ header: string | null; matches: boolean }> = [
      { header: null, matches: false },
      { header: current, matches: true },
      { header: `W/${current}`, matches: true },
      { header: `"stale", ${current}`, matches: true },
      { header: "*", matches: true },
      { header: '"stale"', matches: false },
      { header: etag, matches: false },
    ];
    for (const c of cases) {
      expect(etagMatches(c.header, current)).toBe(c.matches);
    }
  });

  test("conditional GET/HEAD matrix: matching If-None-Match → 304, mismatch → normal 200/206", async () => {
    const { store, url, body } = await setupSimpleAsset(tmpDir);
    const config = createConfig(tmpDir);
    const probe = await handleDocAsset(store as never, config, url);
    const etag = probe.headers.get("etag") ?? "";
    await probe.arrayBuffer();
    expect(etag).toMatch(STRONG_ETAG_RE);

    const cases: Array<{
      name: string;
      method: "GET" | "HEAD";
      ifNoneMatch: string;
      range?: string;
      status: number;
      bodyText: string;
      contentRange?: string;
    }> = [
      {
        name: "GET full, match",
        method: "GET",
        ifNoneMatch: etag,
        status: 304,
        bodyText: "",
      },
      {
        name: "HEAD full, match",
        method: "HEAD",
        ifNoneMatch: etag,
        status: 304,
        bodyText: "",
      },
      {
        name: "GET range, match (conditional wins over Range)",
        method: "GET",
        ifNoneMatch: etag,
        range: "bytes=0-4",
        status: 304,
        bodyText: "",
      },
      {
        name: "GET full, mismatch",
        method: "GET",
        ifNoneMatch: '"stale"',
        status: 200,
        bodyText: body,
      },
      {
        name: "GET range, mismatch → normal 206",
        method: "GET",
        ifNoneMatch: '"stale"',
        range: "bytes=0-4",
        status: 206,
        bodyText: "01234",
        contentRange: `bytes 0-4/${body.length}`,
      },
      {
        name: "HEAD range, mismatch → normal 206",
        method: "HEAD",
        ifNoneMatch: '"stale"',
        range: "bytes=0-4",
        status: 206,
        bodyText: "",
        contentRange: `bytes 0-4/${body.length}`,
      },
    ];

    for (const c of cases) {
      const headers: Record<string, string> = {
        "If-None-Match": c.ifNoneMatch,
      };
      if (c.range) {
        headers.Range = c.range;
      }
      const req = new Request("http://localhost/api/doc-asset", {
        method: c.method,
        headers,
      });
      const res = await handleDocAsset(store as never, config, url, req);
      expect(res.status).toBe(c.status);
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toBe(DOC_ASSET_CACHE_CONTROL);
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(await res.text()).toBe(c.bodyText);
      if (c.status === 304) {
        expect(res.headers.get("content-length")).toBeNull();
        expect(res.headers.get("content-range")).toBeNull();
      } else {
        expect(res.headers.get("content-range")).toBe(c.contentRange ?? null);
      }
    }
  });
});

describe("pdfjs vendor assets (helper)", () => {
  test("allowlist: cMaps are .bcmap only; standard fonts match shipped extensions", () => {
    expect(PDFJS_CMAP_EXTENSIONS).toEqual([".bcmap"]);
    expect(new Set(PDFJS_STANDARD_FONT_EXTENSIONS)).toEqual(
      new Set([".pfb", ".ttf"])
    );
    expect(isSafePdfjsAssetFilename("UniJIS-UCS2-H.bcmap", "cmaps")).toBe(true);
    expect(isSafePdfjsAssetFilename("evil.js", "cmaps")).toBe(false);
    expect(isSafePdfjsAssetFilename("../x.bcmap", "cmaps")).toBe(false);
    expect(isSafePdfjsAssetFilename("a/b.bcmap", "cmaps")).toBe(false);
    expect(isSafePdfjsAssetFilename("%2e%2e%2fx.bcmap", "cmaps")).toBe(false);
    expect(
      isSafePdfjsAssetFilename("LiberationSans-Regular.ttf", "standard_fonts")
    ).toBe(true);
    expect(isSafePdfjsAssetFilename("FoxitSerif.pfb", "standard_fonts")).toBe(
      true
    );
    expect(isSafePdfjsAssetFilename("LICENSE_FOXIT", "standard_fonts")).toBe(
      false
    );
  });

  test("package root resolves independently and is non-empty", async () => {
    const root = await resolvePdfjsPackageRoot();
    expect(root).toBeTruthy();
    expect(root).toContain("pdfjs-dist");
  });

  test("GET/HEAD worker, cmap, standard font with immutable cache", async () => {
    const workerGet = await handlePdfjsAsset({ kind: "worker", method: "GET" });
    expect(workerGet.status).toBe(200);
    expect(workerGet.headers.get("content-type")).toBe("text/javascript");
    expect(workerGet.headers.get("cache-control")).toBe(
      PDFJS_ASSET_CACHE_CONTROL
    );
    expect(workerGet.headers.get("cache-control")).toContain("immutable");
    expect(workerGet.headers.get("cache-control")).not.toContain("no-store");
    const workerBody = await workerGet.text();
    expect(workerBody.length).toBeGreaterThan(1000);

    const workerHead = await handlePdfjsAsset({
      kind: "worker",
      method: "HEAD",
    });
    expect(workerHead.status).toBe(200);
    expect(workerHead.headers.get("cache-control")).toBe(
      PDFJS_ASSET_CACHE_CONTROL
    );
    expect(workerHead.headers.get("content-length")).toBe(
      workerGet.headers.get("content-length")
    );
    expect(await workerHead.text()).toBe("");

    const cmapGet = await handlePdfjsAsset({
      kind: "cmaps",
      file: "UniJIS-UCS2-H.bcmap",
      method: "GET",
    });
    expect(cmapGet.status).toBe(200);
    expect(cmapGet.headers.get("cache-control")).toBe(
      PDFJS_ASSET_CACHE_CONTROL
    );
    expect((await cmapGet.arrayBuffer()).byteLength).toBeGreaterThan(10);

    const cmapHead = await handlePdfjsAsset({
      kind: "cmaps",
      file: "UniJIS-UCS2-H.bcmap",
      method: "HEAD",
    });
    expect(cmapHead.status).toBe(200);
    expect(await cmapHead.text()).toBe("");

    const fontGet = await handlePdfjsAsset({
      kind: "standard_fonts",
      file: "LiberationSans-Regular.ttf",
      method: "GET",
    });
    expect(fontGet.status).toBe(200);
    expect(fontGet.headers.get("content-type")).toBe("font/ttf");
    expect(fontGet.headers.get("cache-control")).toBe(
      PDFJS_ASSET_CACHE_CONTROL
    );
    expect((await fontGet.arrayBuffer()).byteLength).toBeGreaterThan(100);

    const fontHead = await handlePdfjsAsset({
      kind: "standard_fonts",
      file: "LiberationSans-Regular.ttf",
      method: "HEAD",
    });
    expect(fontHead.status).toBe(200);
    expect(fontHead.headers.get("cache-control")).toBe(
      PDFJS_ASSET_CACHE_CONTROL
    );
    expect(await fontHead.text()).toBe("");
  });

  test("invalid :file and package-root failures → 404; escape candidates rejected", async () => {
    for (const file of [
      "../pdf.mjs",
      "a/b.bcmap",
      "nope.bcmap",
      "evil.js",
      "%2e%2e%2fpdf.mjs",
    ]) {
      const res = await handlePdfjsAsset({
        kind: "cmaps",
        file,
        method: "GET",
      });
      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe("NOT_FOUND");
    }

    // Independent package-root failure fails closed
    const noRoot = await handlePdfjsAsset({
      kind: "worker",
      method: "GET",
      resolvePackageRoot: async () => null,
    });
    expect(noRoot.status).toBe(404);

    // Escape via injectable candidate resolver pointing outside package
    const outside = await mkdtemp(join(tmpdir(), "gno-pdfjs-escape-"));
    try {
      const evil = join(outside, "evil.bcmap");
      await writeFile(evil, "not-a-cmap");
      const res = await handlePdfjsAsset({
        kind: "cmaps",
        file: "evil.bcmap",
        method: "GET",
        resolveCandidate: async () => evil,
      });
      // rootedCandidate is under package cmaps/evil.bcmap (missing → 404)
      // and outside candidate is rejected by containment if used
      expect(res.status).toBe(404);
    } finally {
      await safeRm(outside);
    }

    // Candidate resolver returns path outside package for worker
    const outsideWorker = await mkdtemp(join(tmpdir(), "gno-pdfjs-wescape-"));
    try {
      const evilWorker = join(outsideWorker, "evil.mjs");
      await writeFile(evilWorker, "console.log(1)");
      const res = await handlePdfjsAsset({
        kind: "worker",
        method: "GET",
        resolveCandidate: async () => evilWorker,
      });
      expect(res.status).toBe(404);
    } finally {
      await safeRm(outsideWorker);
    }
  });

  test("isContainedInRoot fails closed on EACCES/ELOOP", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-contain-root-"));
    const cand = join(root, "x");
    await writeFile(cand, "x");
    try {
      const eaccess = async (p: string) => {
        if (p === cand) {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return p;
      };
      expect(await isContainedInRoot(root, cand, eaccess)).toBe(false);
      const eloop = async (p: string) => {
        if (p === cand) {
          throw Object.assign(new Error("loop"), { code: "ELOOP" });
        }
        return p;
      };
      expect(await isContainedInRoot(root, cand, eloop)).toBe(false);
    } finally {
      await safeRm(root);
    }
  });
});

// Production route registration tests live in fn112-production-routes.test.ts
// and invoke createDocAssetRouteHandlers / handlePdfjsVendorRequest — the same
// factories mounted by server.ts (I1-04).
