import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  classifyPdfError,
  clampZoom,
  computeEffectiveScale,
  DEFAULT_ZOOM,
  fitPageScale,
  fitWidthScale,
  getDocument,
  getPdfMetrics,
  isRenderingCancelled,
  MAX_CANVAS_PIXELS,
  MAX_ZOOM,
  MIN_ZOOM,
  sanitizeAnnotationUrl,
  stepZoom,
  TextLayer,
  type PdfFallbackReason,
} from "../../../../src/serve/public/lib/pdf";

const SRC_ROOT = join(import.meta.dir, "../../../../src");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("fn-112 PDF fixtures (semantic)", () => {
  const fixtureDir = join(import.meta.dir, "../../../fixtures/conversion/pdf");

  test("js-action.pdf has catalog /OpenAction with /S /JavaScript and /JS", () => {
    const bytes = readFileSync(join(fixtureDir, "js-action.pdf"), "utf8");
    // Catalog must wire OpenAction (names-tree alone is insufficient — I2-4)
    expect(bytes).toContain("/OpenAction");
    expect(bytes).toMatch(/\/OpenAction\s+\d+\s+0\s+R/);
    expect(bytes).toContain("/S /JavaScript");
    expect(bytes).toMatch(/\/JS\s*\(/);
    // Must not be names-tree-only: the action dict is a real catalog target
    expect(bytes).toMatch(
      /1 0 obj<< \/Type \/Catalog \/Pages 2 0 R \/OpenAction \d+ 0 R >>/
    );
  });

  test("standard-font.pdf has no embedded FontFile stream", () => {
    const bytes = readFileSync(join(fixtureDir, "standard-font.pdf"), "utf8");
    expect(bytes).not.toContain("FontFile");
    expect(bytes).toContain("/BaseFont /Helvetica");
  });

  test("cjk-cmap.pdf references UniJIS-UCS2-H Type0 encoding", () => {
    const bytes = readFileSync(join(fixtureDir, "cjk-cmap.pdf"), "utf8");
    expect(bytes).toContain("/Encoding /UniJIS-UCS2-H");
    expect(bytes).toContain("/Subtype /Type0");
  });

  test("zero-page.pdf has /Count 0", () => {
    const bytes = readFileSync(join(fixtureDir, "zero-page.pdf"), "utf8");
    expect(bytes).toContain("/Count 0");
  });
});

describe("lib/pdf single-import rule", () => {
  test("only lib/pdf.ts imports pdfjs-dist", () => {
    const files = collectTsFiles(SRC_ROOT);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (
        /from\s+['"]pdfjs-dist/.test(text) ||
        /from\s+['"]pdfjs-dist\//.test(text)
      ) {
        if (!file.endsWith(`${join("public", "lib", "pdf.ts")}`)) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("facade source has no isEvalSupported and no enableScripting: true", () => {
    const src = readFileSync(join(SRC_ROOT, "serve/public/lib/pdf.ts"), "utf8");
    expect(src).not.toContain("isEvalSupported");
    expect(src).not.toMatch(/enableScripting\s*:\s*true/);
  });

  test("range-mode loading policy: disableStream + disableAutoFetch, no fetch-bridge workarounds", () => {
    const src = readFileSync(join(SRC_ROOT, "serve/public/lib/pdf.ts"), "utf8");
    // Product range-mode policy (windowed viewer + holdable Range fetches).
    expect(src).toMatch(/disableStream\s*:\s*true/);
    expect(src).toMatch(/disableAutoFetch\s*:\s*true/);
    expect(src).not.toMatch(/disableStream\s*:\s*false/);
    expect(src).not.toMatch(/disableAutoFetch\s*:\s*false/);
    // Superseded workarounds must not reappear in the product facade.
    expect(src).not.toContain("installPdfjsRangeLengthBridge");
    expect(src).not.toContain("rewrites Content-Length from Content-Range");
    expect(src).not.toContain("synthetic first-chunk");
    expect(src).not.toMatch(/getDocument\s*\(\s*\{[^}]*\blength\s*:/s);
  });

  test("exports TextLayer, getDocument, classifiers, PdfFallbackReason surface", () => {
    expect(typeof TextLayer).toBe("function");
    expect(typeof getDocument).toBe("function");
    expect(typeof classifyPdfError).toBe("function");
    expect(typeof isRenderingCancelled).toBe("function");
    // Type-only surface exercised via assignability
    const reasons: PdfFallbackReason[] = [
      "corrupt",
      "password",
      "network",
      "bootstrap",
    ];
    expect(reasons).toHaveLength(4);
  });
});

describe("zoom / fit / DPR cap math", () => {
  test("clampZoom bounds and non-finite", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
  });

  test("stepZoom steps and clamps", () => {
    expect(stepZoom(1, 1)).toBeCloseTo(1.1, 5);
    expect(stepZoom(1, -1)).toBeCloseTo(0.9, 5);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
  });

  test("fitWidthScale portrait and landscape", () => {
    // Portrait page 600x800 at scale 1, container 300 wide
    expect(
      fitWidthScale({ width: 600, height: 800 }, { width: 300, height: 500 })
    ).toBeCloseTo(0.5, 5);
    // Landscape viewport 800x400 into 400-wide container
    expect(
      fitWidthScale({ width: 800, height: 400 }, { width: 400, height: 300 })
    ).toBeCloseTo(0.5, 5);
  });

  test("fitPageScale uses the tighter dimension", () => {
    // Page 600x800, container 300x500 → width-limited 0.5
    expect(
      fitPageScale({ width: 600, height: 800 }, { width: 300, height: 500 })
    ).toBeCloseTo(0.5, 5);
    // Landscape page that is height-limited
    expect(
      fitPageScale({ width: 800, height: 400 }, { width: 800, height: 200 })
    ).toBeCloseTo(0.5, 5);
  });

  test("computeEffectiveScale applies min(dpr,2)*zoom and area cap", () => {
    const r = computeEffectiveScale({
      zoom: 1,
      devicePixelRatio: 3,
      cssWidth: 100,
      cssHeight: 100,
    });
    expect(r.dpr).toBe(2);
    expect(r.renderScale).toBeCloseTo(2, 5);
    expect(r.canvasWidth).toBe(200);
    expect(r.canvasHeight).toBe(200);

    // Huge page hits area cap
    const huge = computeEffectiveScale({
      zoom: 2,
      devicePixelRatio: 2,
      cssWidth: 8000,
      cssHeight: 8000,
      maxCanvasPixels: MAX_CANVAS_PIXELS,
    });
    expect(huge.canvasWidth * huge.canvasHeight).toBeLessThanOrEqual(
      MAX_CANVAS_PIXELS
    );
  });
});

describe("sanitizeAnnotationUrl", () => {
  test("allows http(s) only", () => {
    expect(sanitizeAnnotationUrl("https://example.com/a")).toBe(
      "https://example.com/a"
    );
    expect(sanitizeAnnotationUrl("http://example.com")).toBe(
      "http://example.com/"
    );
    expect(sanitizeAnnotationUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeAnnotationUrl("file:///etc/passwd")).toBeNull();
    expect(sanitizeAnnotationUrl("data:text/html,hi")).toBeNull();
    expect(sanitizeAnnotationUrl("/relative/path")).toBeNull();
    expect(sanitizeAnnotationUrl("")).toBeNull();
  });
});

describe("classifyPdfError / isRenderingCancelled", () => {
  test("classifies password, corrupt, network, bootstrap", () => {
    expect(
      classifyPdfError({ name: "PasswordException", message: "Need password" })
    ).toBe("password");
    expect(
      classifyPdfError({ name: "InvalidPDFException", message: "Invalid PDF" })
    ).toBe("corrupt");
    expect(
      classifyPdfError({
        name: "ResponseException",
        message: "Unexpected server response (404)",
      })
    ).toBe("network");
    expect(
      classifyPdfError(
        new Error("Setting up fake worker failed: pdf.worker missing")
      )
    ).toBe("bootstrap");
  });

  test("isRenderingCancelled", () => {
    expect(
      isRenderingCancelled({
        name: "RenderingCancelledException",
        message: "cancelled",
      })
    ).toBe(true);
    expect(isRenderingCancelled(new Error("boom"))).toBe(false);
  });
});

describe("__gnoPdfMetrics channel", () => {
  afterEach(() => {
    getPdfMetrics().reset({ capacity: 2000 });
  });

  test("attaches once to globalThis and survives independently of React", () => {
    const m = getPdfMetrics();
    expect(globalThis.__gnoPdfMetrics).toBe(m);
    const docId = m.mintDocId();
    const taskId = m.mintTaskId();
    const gen = m.bumpGen(docId);
    m.recordRenderStart({
      docId,
      pageNumber: 1,
      taskId,
      genId: gen,
      scale: 1,
      canvasWidth: 100,
      canvasHeight: 100,
    });
    // Simulate unmount — channel still readable
    expect(globalThis.__gnoPdfMetrics?.snapshot().events).toHaveLength(1);
  });

  test("records full schema with monotonic seq and opaque ids", () => {
    const m = getPdfMetrics();
    m.reset({ capacity: 100 });
    const docId = m.mintDocId();
    expect(docId).toMatch(/^d\d+$/);
    const taskId = m.mintTaskId();
    expect(taskId).toMatch(/^r\d+$/);
    const gen = m.bumpGen(docId);
    m.recordRenderStart({
      docId,
      pageNumber: 2,
      taskId,
      genId: gen,
      scale: 1.5,
      canvasWidth: 200,
      canvasHeight: 300,
    });
    m.recordRenderCancel({ docId, pageNumber: 2, taskId, genId: gen });
    m.recordRenderSettle({
      docId,
      pageNumber: 2,
      taskId,
      genId: gen,
      outcome: "cancelled",
    });
    m.recordPageCleanup({ docId, pageNumber: 2 });
    m.recordDocumentDestroy({ docId });

    const snap = m.snapshot();
    expect(snap.dropped).toBe(0);
    expect(snap.events).toHaveLength(5);
    const seqs = snap.events.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    for (const e of snap.events) {
      expect(e).toHaveProperty("seq");
      expect(e).toHaveProperty("t");
      expect(e).toHaveProperty("docId");
      expect(e).toHaveProperty("pageNumber");
      expect(e).toHaveProperty("taskId");
      expect(e).toHaveProperty("genId");
      expect(e).toHaveProperty("kind");
      expect(e).toHaveProperty("outcome");
      expect(e).toHaveProperty("scale");
      expect(e).toHaveProperty("canvasWidth");
      expect(e).toHaveProperty("canvasHeight");
    }
    expect(snap.events[0]?.kind).toBe("renderStart");
    expect(snap.events[0]?.canvasWidth).toBe(200);
    expect(snap.events[2]?.outcome).toBe("cancelled");
    expect(snap.events[4]?.kind).toBe("documentDestroy");
    expect(snap.events[4]?.pageNumber).toBeNull();
  });

  test("genuine dual getDocument loads of viewer-links.pdf: distinct ids + content + privacy", async () => {
    const m = getPdfMetrics();
    m.reset({ capacity: 100 });

    const checkedInFixture = join(
      import.meta.dir,
      "../../../fixtures/conversion/pdf/viewer-links.pdf"
    );

    // Distinctive real path that still successfully resolves to the fixture:
    // copy the checked-in bytes into an isolated temp dir with a secret segment.
    const secretDir = mkdtempSync(
      join(tmpdir(), "fn112-secret-fixture-path-XYZ123-")
    );
    const secretFilename = "viewer-links.pdf";
    const secretAbs = join(secretDir, secretFilename);
    copyFileSync(checkedInFixture, secretAbs);
    const secretUrl = pathToFileURL(secretAbs).href;
    const secretTitle = "TOP_SECRET_TITLE_NEVER_IN_METRICS";
    const knownContent = "KNOWN_GLYPH_RUN_ALPHA the quick brown fox";
    const knownExternal = "https://example.com/gno-pdf-viewer";

    try {
      // Same real fixture URL for both loads (requirement: dual successful loads).
      const task1 = getDocument({ url: secretUrl });
      const task2 = getDocument({ url: secretUrl });

      expect(task1.gnoDocId).toMatch(/^d\d+$/);
      expect(task2.gnoDocId).toMatch(/^d\d+$/);
      expect(task1.gnoDocId).not.toBe(task2.gnoDocId);

      // Smuggled extra `docId` property must not become the opaque id (no override API)
      const smuggledParams = {
        url: secretUrl,
        docId: "caller-controlled-id",
      };
      const taskSmuggled = getDocument(smuggledParams as { url: string });
      expect(taskSmuggled.gnoDocId).not.toBe("caller-controlled-id");
      expect(taskSmuggled.gnoDocId).toMatch(/^d\d+$/);
      const smuggledDoc = await taskSmuggled.promise;
      expect(smuggledDoc.numPages).toBe(5);
      await taskSmuggled.destroy();

      // Await BOTH loading-task promises — genuine success required
      const [doc1, doc2] = await Promise.all([task1.promise, task2.promise]);
      expect(doc1.numPages).toBe(5);
      expect(doc2.numPages).toBe(5);

      // Known fixture content from page 1
      const page1 = await doc1.getPage(1);
      const textContent = await page1.getTextContent();
      const joined = textContent.items
        .map((item) => ("str" in item ? String(item.str) : ""))
        .join(" ");
      expect(joined).toContain(knownContent);
      expect(joined).toContain("Viewer Link Fixture - Page 1");

      const annots = await page1.getAnnotations();
      expect(annots.length).toBeGreaterThanOrEqual(3);
      const urls = annots.map(
        (a) =>
          (a as { url?: string; unsafeUrl?: string }).url ??
          (a as { unsafeUrl?: string }).unsafeUrl ??
          ""
      );
      expect(urls.some((u) => u.includes(knownExternal))).toBe(true);
      expect(urls.some((u) => u.startsWith("javascript:"))).toBe(true);

      // Metrics correlation using facade-minted ids only
      const gen1 = m.bumpGen(task1.gnoDocId);
      const tBefore = performance.now();
      m.recordRenderStart({
        docId: task1.gnoDocId,
        pageNumber: 1,
        taskId: m.mintTaskId(),
        genId: gen1,
        scale: 1,
        canvasWidth: 10,
        canvasHeight: 10,
      });
      const tAfter = performance.now();
      m.recordDocumentDestroy({ docId: task1.gnoDocId });
      m.recordDocumentDestroy({ docId: task2.gnoDocId });

      // t is direct performance.now() reading (not elapsed-from-t0)
      const snap = m.snapshot();
      const startEv = snap.events.find((e) => e.kind === "renderStart");
      expect(startEv).toBeDefined();
      expect(typeof startEv?.t).toBe("number");
      expect(startEv!.t).toBeGreaterThanOrEqual(tBefore - 1);
      expect(startEv!.t).toBeLessThanOrEqual(tAfter + 1);
      // Distinct from a pure 0-based elapsed counter
      expect(startEv!.t).toBeGreaterThan(0);

      const exported = JSON.stringify(m.export());
      // Privacy: distinctive path/url/filename/title/content must not leak
      expect(exported).not.toContain(secretDir);
      expect(exported).not.toContain("fn112-secret-fixture-path-XYZ123");
      expect(exported).not.toContain(secretAbs);
      expect(exported).not.toContain(secretUrl);
      expect(exported).not.toContain(secretFilename);
      expect(exported).not.toContain(secretTitle);
      expect(exported).not.toContain(knownContent);
      expect(exported).not.toContain(knownExternal);
      expect(exported).not.toContain("file://");
      expect(exported).not.toContain("/api/doc-asset");
      // Opaque ids present
      expect(exported).toContain(task1.gnoDocId);
      expect(exported).toContain(task2.gnoDocId);

      // Loading tasks own document transport teardown in PDF.js 6.
      await task1.destroy();
      await task2.destroy();
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  test("metrics event t is direct performance.now() (not elapsed)", () => {
    const m = getPdfMetrics();
    m.reset({ capacity: 10 });
    const docId = m.mintDocId();
    const before = performance.now();
    m.recordPageCleanup({ docId, pageNumber: 1 });
    const after = performance.now();
    const ev = m.snapshot().events[0];
    expect(ev).toBeDefined();
    expect(ev!.t).toBeGreaterThanOrEqual(before - 1);
    expect(ev!.t).toBeLessThanOrEqual(after + 1);
    // If t were (now - t0Perf) right after reset, it would be near 0;
    // performance.now() since process start is typically much larger.
    // We only assert the absolute reading falls in the [before, after] window.
    expect(m.snapshot().t0Epoch).toBeGreaterThan(0);
  });

  test("ring buffer drops oldest and increments dropped", () => {
    const m = getPdfMetrics();
    m.reset({ capacity: 3 });
    const docId = m.mintDocId();
    for (let i = 0; i < 5; i++) {
      m.recordPageCleanup({ docId, pageNumber: i + 1 });
    }
    const snap = m.snapshot();
    expect(snap.capacity).toBe(3);
    expect(snap.events).toHaveLength(3);
    expect(snap.dropped).toBe(2);
    // Oldest dropped: pages 1,2 gone; 3,4,5 remain
    expect(snap.events.map((e) => e.pageNumber)).toEqual([3, 4, 5]);
  });

  test("reset clears records/dropped/seq; snapshot is deeply frozen clone", () => {
    const m = getPdfMetrics();
    m.reset({ capacity: 10 });
    const docId = m.mintDocId();
    m.recordPageCleanup({ docId, pageNumber: 1 });
    const snap1 = m.snapshot();
    expect(snap1.events).toHaveLength(1);

    // Deep freeze: container, events array, and each event object
    expect(Object.isFrozen(snap1)).toBe(true);
    expect(Object.isFrozen(snap1.events)).toBe(true);
    expect(Object.isFrozen(snap1.events[0])).toBe(true);

    // Mutating a returned event object must throw and must not alter live channel
    expect(() => {
      // @ts-expect-error intentional mutation of frozen event
      snap1.events[0].kind = "renderStart";
    }).toThrow();
    expect(m.snapshot().events[0]?.kind).toBe("pageCleanup");

    // Mutating the frozen events array must throw
    expect(() => {
      // @ts-expect-error intentional mutation of frozen array
      snap1.events.push({} as never);
    }).toThrow();

    m.reset({ capacity: 50 });
    const snap2 = m.snapshot();
    expect(snap2.events).toHaveLength(0);
    expect(snap2.dropped).toBe(0);
    expect(snap2.seqHigh).toBe(0);
    expect(snap2.capacity).toBe(50);
  });

  test("export round-trips through JSON", () => {
    const m = getPdfMetrics();
    m.reset({ capacity: 20 });
    const docId = m.mintDocId();
    const taskId = m.mintTaskId();
    const gen = m.bumpGen(docId);
    m.recordRenderStart({
      docId,
      pageNumber: 1,
      taskId,
      genId: gen,
      scale: 1,
      canvasWidth: 50,
      canvasHeight: 50,
    });
    m.recordRenderSettle({
      docId,
      pageNumber: 1,
      taskId,
      genId: gen,
      outcome: "completed",
    });
    const exported = m.export();
    const parsed = JSON.parse(JSON.stringify(exported));
    expect(parsed).toEqual(exported);
  });
});
