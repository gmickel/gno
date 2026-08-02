import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { PdfPageView } from "../../../../../src/serve/public/components/pdf/PdfPageView";

const sanitizeAnnotationUrl = mock((url: string) => {
  if (url.startsWith("https:") || url.startsWith("http:")) return url;
  return null;
});

class FakeTextLayer {
  static instances: FakeTextLayer[] = [];
  static constructorCount = 0;
  static renderCount = 0;
  static updateCount = 0;
  static cancelCount = 0;
  /** Next constructed layer holds render until settleRender(). */
  static holdNextRender = false;

  cancelled = false;
  renderCount = 0;
  updateCount = 0;
  opts: {
    textContentSource: unknown;
    container: HTMLElement;
    viewport: { scale: number };
  };
  private renderResolve: (() => void) | null = null;
  private holdThisRender = false;

  constructor(opts: {
    textContentSource: unknown;
    container: HTMLElement;
    viewport: { scale: number };
  }) {
    this.opts = opts;
    FakeTextLayer.constructorCount += 1;
    FakeTextLayer.instances.push(this);
    if (FakeTextLayer.holdNextRender) {
      this.holdThisRender = true;
      FakeTextLayer.holdNextRender = false;
    }
  }

  render = mock(async () => {
    FakeTextLayer.renderCount += 1;
    this.renderCount += 1;
    this.opts.container.setAttribute(
      "data-layer-instance",
      String(FakeTextLayer.instances.indexOf(this))
    );
    this.opts.container.dataset.owner = `layer-${FakeTextLayer.instances.indexOf(this)}`;
    this.opts.container.dataset.renderScale = String(this.opts.viewport.scale);
    if (this.holdThisRender) {
      await new Promise<void>((resolve) => {
        this.renderResolve = resolve;
      });
      // Stale completion write attempt
      if (!this.cancelled) {
        this.opts.container.dataset.owner = "stale-finished";
        this.opts.container.appendChild(document.createTextNode("STALE-CHILD"));
      }
    }
  });

  settleRender(): void {
    this.renderResolve?.();
    this.renderResolve = null;
  }

  update = mock((_args: { viewport: { scale: number } }) => {
    FakeTextLayer.updateCount += 1;
    this.updateCount += 1;
    this.opts.viewport = _args.viewport;
    this.opts.container.dataset.renderScale = String(_args.viewport.scale);
  });

  cancel = mock(() => {
    FakeTextLayer.cancelCount += 1;
    this.cancelled = true;
    this.renderResolve?.();
    this.renderResolve = null;
  });

  static reset(): void {
    FakeTextLayer.instances = [];
    FakeTextLayer.constructorCount = 0;
    FakeTextLayer.renderCount = 0;
    FakeTextLayer.updateCount = 0;
    FakeTextLayer.cancelCount = 0;
    FakeTextLayer.holdNextRender = false;
  }
}

const convertToViewportPoint = (x: number, y: number) => {
  return [x, 800 - y];
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type PageProxy = {
  getViewport: (o: { scale: number }) => {
    width: number;
    height: number;
    scale: number;
    convertToViewportPoint: typeof convertToViewportPoint;
  };
  getTextContent: () => Promise<unknown>;
  getAnnotations: () => Promise<unknown[]>;
  cleanup: () => void;
};

type DocCtl = {
  pageHold: Deferred<PageProxy> | null;
  textHold: Deferred<unknown> | null;
  annotHold: Deferred<unknown[]> | null;
  destHold: Deferred<unknown> | null;
  pageIndexHold: Deferred<number> | null;
  getPageCalls: number;
  getTextCalls: number;
  getAnnotCalls: number;
  getDestCalls: number;
  getPageIndexCalls: number;
  pageNumberLabel: number;
  annots: unknown[];
};

function makePageProxy(ctl: DocCtl): PageProxy {
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 200 * scale,
      height: 300 * scale,
      scale,
      convertToViewportPoint,
    }),
    getTextContent: async () => {
      ctl.getTextCalls += 1;
      if (ctl.textHold) {
        return ctl.textHold.promise;
      }
      return {
        items: [{ str: `page-${ctl.pageNumberLabel}` }],
        styles: {},
      };
    },
    getAnnotations: async () => {
      ctl.getAnnotCalls += 1;
      if (ctl.annotHold) {
        return ctl.annotHold.promise;
      }
      return ctl.annots;
    },
    cleanup: () => undefined,
  };
}

function makeControlledDoc(
  label: number,
  opts?: {
    holdPage?: boolean;
    holdText?: boolean;
    holdAnnots?: boolean;
    holdDest?: boolean;
    holdPageIndex?: boolean;
    annots?: unknown[];
  }
) {
  const ctl: DocCtl = {
    pageHold: opts?.holdPage ? deferred() : null,
    textHold: opts?.holdText ? deferred() : null,
    annotHold: opts?.holdAnnots ? deferred() : null,
    destHold: opts?.holdDest ? deferred() : null,
    pageIndexHold: opts?.holdPageIndex ? deferred() : null,
    getPageCalls: 0,
    getTextCalls: 0,
    getAnnotCalls: 0,
    getDestCalls: 0,
    getPageIndexCalls: 0,
    pageNumberLabel: label,
    annots: opts?.annots ?? [],
  };

  const doc = {
    getPage: async (_n?: number) => {
      ctl.getPageCalls += 1;
      if (ctl.pageHold) {
        return ctl.pageHold.promise;
      }
      return makePageProxy(ctl);
    },
    getDestination: async (_name: string) => {
      ctl.getDestCalls += 1;
      if (ctl.destHold) {
        return ctl.destHold.promise;
      }
      return [{ num: 3, gen: 0 }];
    },
    getPageIndex: async (_ref: unknown) => {
      ctl.getPageIndexCalls += 1;
      if (ctl.pageIndexHold) {
        return ctl.pageIndexHold.promise;
      }
      return 2;
    },
    _ctl: ctl,
    _releasePage: () => {
      const page = makePageProxy(ctl);
      ctl.pageHold?.resolve(page);
      ctl.pageHold = null;
      return page;
    },
    _releaseText: (v?: unknown) => {
      ctl.textHold?.resolve(
        v ?? { items: [{ str: `stale-${label}` }], styles: {} }
      );
      ctl.textHold = null;
    },
    _releaseAnnots: (v?: unknown[]) => {
      ctl.annotHold?.resolve(v ?? ctl.annots);
      ctl.annotHold = null;
    },
    _releaseDest: (v?: unknown) => {
      ctl.destHold?.resolve(v ?? [{ num: 3, gen: 0 }]);
      ctl.destHold = null;
    },
    _releasePageIndex: (v?: number) => {
      ctl.pageIndexHold?.resolve(v ?? 2);
      ctl.pageIndexHold = null;
    },
  };
  return doc;
}

function makeDoc(
  annots: unknown[] = [],
  viewportSize: { width: number; height: number } = { width: 200, height: 300 }
) {
  return {
    getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: viewportSize.width * scale,
        height: viewportSize.height * scale,
        scale,
        convertToViewportPoint,
      }),
      getTextContent: async () => ({ items: [], styles: {} }),
      getAnnotations: async () => annots,
      cleanup: () => undefined,
    }),
    getDestination: async () => [{ num: 3, gen: 0 }],
    getPageIndex: async () => 2,
  };
}

function snapshotContainer(el: HTMLElement) {
  return {
    childCount: el.childNodes.length,
    childHTML: el.innerHTML,
    owner: el.dataset.owner ?? null,
    layerInstance: el.getAttribute("data-layer-instance"),
    renderScale: el.dataset.renderScale ?? null,
    scaleFactor: el.style.getPropertyValue("--scale-factor"),
    totalScale: el.style.getPropertyValue("--total-scale-factor"),
    scaleRoundX: el.style.getPropertyValue("--scale-round-x"),
    scaleRoundY: el.style.getPropertyValue("--scale-round-y"),
    width: el.style.width,
    height: el.style.height,
    text: el.textContent ?? "",
  };
}

function expectSnapshotUnchanged(
  el: HTMLElement,
  before: ReturnType<typeof snapshotContainer>,
  label: string
): void {
  const after = snapshotContainer(el);
  expect(after.childCount, `${label} childCount`).toBe(before.childCount);
  expect(after.childHTML, `${label} childHTML`).toBe(before.childHTML);
  expect(after.owner, `${label} owner`).toBe(before.owner);
  expect(after.layerInstance, `${label} layerInstance`).toBe(
    before.layerInstance
  );
  expect(after.renderScale, `${label} renderScale`).toBe(before.renderScale);
  expect(after.scaleFactor, `${label} scaleFactor`).toBe(before.scaleFactor);
  expect(after.totalScale, `${label} totalScale`).toBe(before.totalScale);
  expect(after.scaleRoundX, `${label} scaleRoundX`).toBe(before.scaleRoundX);
  expect(after.scaleRoundY, `${label} scaleRoundY`).toBe(before.scaleRoundY);
  expect(after.width, `${label} width`).toBe(before.width);
  expect(after.height, `${label} height`).toBe(before.height);
  expect(after.text, `${label} text`).toBe(before.text);
}

function wrapperScale(el: HTMLElement) {
  return {
    scaleFactor: el.style.getPropertyValue("--scale-factor"),
    totalScale: el.style.getPropertyValue("--total-scale-factor"),
    scaleRoundX: el.style.getPropertyValue("--scale-round-x"),
    scaleRoundY: el.style.getPropertyValue("--scale-round-y"),
  };
}

describe("PdfPageView", () => {
  afterEach(() => {
    cleanup();
    FakeTextLayer.reset();
    sanitizeAnnotationUrl.mockClear();
  });

  test("rotation-aware placeholder aspect from viewport-derived width/height", () => {
    render(
      <PdfPageView
        active={false}
        doc={null}
        height={400}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={1}
        rendered={false}
        scale={1}
        width={200}
      />
    );
    expect(screen.getByTestId("pdf-page-1").style.aspectRatio).toBe(
      "200 / 400"
    );
  });

  test("https link target blank noopener; javascript inert; internal page-jump", async () => {
    const onInternal = mock(() => undefined);
    const doc = makeDoc([
      {
        subtype: "Link",
        rect: [10, 700, 100, 720],
        url: "https://example.com/ok",
      },
      {
        subtype: "Link",
        rect: [10, 650, 100, 670],
        url: "javascript:alert(1)",
      },
      {
        subtype: "Link",
        rect: [10, 600, 100, 620],
        dest: "page3",
      },
    ]);

    render(
      <PdfPageView
        active
        doc={doc as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={1}
        rendered
        scale={1}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );

    await waitFor(() => {
      expect(
        document.querySelector('[data-annotation="external"]')
      ).toBeTruthy();
      expect(document.querySelector('[data-annotation="inert"]')).toBeTruthy();
      expect(
        document.querySelector('[data-annotation="internal"]')
      ).toBeTruthy();
    });

    (
      document.querySelector(
        '[data-annotation="internal"]'
      ) as HTMLButtonElement
    ).click();
    await waitFor(() => {
      expect(onInternal).toHaveBeenCalledWith(3);
    });
  });

  test("I3-06: wrapper carries live viewport scale on initial render and zoom update", async () => {
    const doc = makeDoc();
    const { rerender } = render(
      <PdfPageView
        active
        doc={doc as never}
        height={300}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={1}
        rendered
        scale={2}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );

    await waitFor(() => {
      expect(FakeTextLayer.constructorCount).toBe(1);
      expect(FakeTextLayer.renderCount).toBe(1);
    });

    const wrapper = screen.getByTestId("pdf-page-1");
    let ws = wrapperScale(wrapper);
    expect(ws.scaleFactor).toBe("2");
    expect(ws.totalScale).toBe(
      "calc(var(--scale-factor) * var(--user-unit, 1))"
    );
    expect(ws.scaleRoundX).toBe("1px");
    expect(ws.scaleRoundY).toBe("1px");

    const updatesBefore = FakeTextLayer.updateCount;
    rerender(
      <PdfPageView
        active
        doc={doc as never}
        height={300}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={1}
        rendered
        scale={3}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );

    await waitFor(() => {
      expect(FakeTextLayer.updateCount).toBeGreaterThan(updatesBefore);
    });
    // Same layer instance — update path, not recreate
    expect(FakeTextLayer.constructorCount).toBe(1);
    expect(FakeTextLayer.renderCount).toBe(1);

    ws = wrapperScale(wrapper);
    expect(ws.scaleFactor).toBe("3");
    expect(ws.totalScale).toBe(
      "calc(var(--scale-factor) * var(--user-unit, 1))"
    );
    expect(ws.scaleRoundX).toBe("1px");
    expect(ws.scaleRoundY).toBe("1px");
  });

  test("I3-06: CSS page wrapper contract + semantic card surface, no raw colors", () => {
    const cssPath = join(
      import.meta.dir,
      "../../../../../src/serve/public/globals.css"
    );
    const css = readFileSync(cssPath, "utf8");
    const start = css.indexOf("/* ── Native PDF viewer (fn-112)");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = css.indexOf("/* ──", start + 10);
    const block = end > start ? css.slice(start, end) : css.slice(start);

    const pageIdx = block.indexOf(".gno-pdf-page {");
    const innerIdx = block.indexOf(".gno-pdf-page-inner {");
    expect(pageIdx).toBeGreaterThanOrEqual(0);
    expect(innerIdx).toBeGreaterThan(pageIdx);
    const pageRule = block.slice(pageIdx, innerIdx);
    expect(pageRule).toContain("--scale-factor:");
    expect(pageRule).toContain(
      "--total-scale-factor: calc(var(--scale-factor) * var(--user-unit, 1))"
    );
    expect(pageRule).toContain("--scale-round-x: 1px");
    expect(pageRule).toContain("--scale-round-y: 1px");
    expect(block).not.toMatch(/--gno-pdf-paper/);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).not.toMatch(/:\s*\d+\s+\d+%\s+\d+%\s*;/);
    expect(block).toMatch(/hsl\(var\(--card\)\)/);
  });

  test("I3-03: same-component identity replace — deferred getPage OLD-last does not mutate", async () => {
    // OLD holds getPage. NEW completes fully. OLD getPage resolves last.
    // Old path correctly has zero construction (never passed getPage); overall
    // lifecycle counts are nonzero from NEW identity.
    const docOld = makeControlledDoc(1, { holdPage: true });
    const onInternal = mock(() => undefined);

    const { rerender } = render(
      <PdfPageView
        active
        doc={docOld as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={1}
        rendered
        scale={1}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );

    const wrapper = screen.getByTestId("pdf-page-1");
    const textEl = document.querySelector(".gno-pdf-text-layer") as HTMLElement;
    const linkEl = document.querySelector(
      ".gno-pdf-annotation-layer"
    ) as HTMLElement;
    // Seed a marker on containers so we can detect any mutation
    textEl.dataset.probe = "pre-old";
    linkEl.dataset.probe = "pre-old";
    const textSnapBeforeReplace = snapshotContainer(textEl);
    const linkSnapBeforeReplace = snapshotContainer(linkEl);

    // Same component: swap doc+pageNumber while old getPage pending
    const docNew = makeControlledDoc(2, {
      annots: [
        {
          subtype: "Link",
          rect: [10, 700, 100, 720],
          url: "https://example.com/new",
        },
      ],
    });
    rerender(
      <PdfPageView
        active
        doc={docNew as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={2}
        rendered
        scale={1}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );

    // NEW identity owns DOM first
    await waitFor(() => {
      expect(FakeTextLayer.constructorCount).toBe(1);
      expect(FakeTextLayer.renderCount).toBe(1);
    });
    expect(docNew._ctl.getPageCalls).toBeGreaterThanOrEqual(1);
    expect(docNew._ctl.getTextCalls).toBeGreaterThanOrEqual(1);

    expect(wrapperScale(wrapper).scaleFactor).toBe("1");
    expect(snapshotContainer(textEl).owner).toBe("layer-0");
    expect(linkEl.querySelector('[data-annotation="external"]')).toBeTruthy();

    // Compatible zoom on NEW → .update (nonzero update count)
    rerender(
      <PdfPageView
        active
        doc={docNew as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={2}
        rendered
        scale={2}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );
    await waitFor(() => {
      expect(FakeTextLayer.updateCount).toBeGreaterThanOrEqual(1);
    });
    expect(FakeTextLayer.constructorCount).toBe(1);
    expect(FakeTextLayer.renderCount).toBe(1);
    expect(wrapperScale(wrapper).scaleFactor).toBe("2");

    const textAfterZoom = snapshotContainer(textEl);
    const linkAfterZoom = snapshotContainer(linkEl);
    const wrapperAfterZoom = wrapperScale(wrapper);

    // OLD getPage completes LAST
    await act(async () => {
      docOld._releasePage();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Old never constructed (held at getPage) — overall counts still nonzero from NEW
    expect(FakeTextLayer.constructorCount).toBe(1);
    expect(FakeTextLayer.renderCount).toBe(1);
    expect(FakeTextLayer.updateCount).toBeGreaterThanOrEqual(1);
    // No cancel of a never-built old layer required; new layer not cancelled
    expect(FakeTextLayer.instances[0]!.cancelled).toBe(false);

    // Neither container mutated by OLD-last
    expectSnapshotUnchanged(textEl, textAfterZoom, "text after old getPage");
    expectSnapshotUnchanged(linkEl, linkAfterZoom, "link after old getPage");
    expect(wrapperScale(wrapper).scaleFactor).toBe(
      wrapperAfterZoom.scaleFactor
    );
    expect(onInternal).not.toHaveBeenCalled();
    // probe markers from before replace must not reappear from old path
    void textSnapBeforeReplace;
    void linkSnapBeforeReplace;
  });

  test("I3-03: same-component identity replace — deferred textContent OLD-last", async () => {
    const docOld = makeControlledDoc(1, { holdText: true });
    const onInternal = mock(() => undefined);

    const { rerender } = render(
      <PdfPageView
        active
        doc={docOld as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={1}
        rendered
        scale={1}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );

    // Wait until old is holding at textContent (getPage done)
    await waitFor(() => {
      expect(docOld._ctl.getPageCalls).toBeGreaterThanOrEqual(1);
      expect(docOld._ctl.getTextCalls).toBeGreaterThanOrEqual(1);
    });
    // No construction yet (held at text)
    expect(FakeTextLayer.constructorCount).toBe(0);

    const textEl = document.querySelector(".gno-pdf-text-layer") as HTMLElement;
    const linkEl = document.querySelector(
      ".gno-pdf-annotation-layer"
    ) as HTMLElement;
    textEl.dataset.probe = "old-text-held";
    const oldProbeSnap = snapshotContainer(textEl);

    const docNew = makeControlledDoc(2);
    rerender(
      <PdfPageView
        active
        doc={docNew as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={2}
        rendered
        scale={1}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );

    await waitFor(() => {
      expect(FakeTextLayer.constructorCount).toBe(1);
      expect(FakeTextLayer.renderCount).toBe(1);
    });

    // Zoom for update count
    rerender(
      <PdfPageView
        active
        doc={docNew as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={2}
        rendered
        scale={1.5}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );
    await waitFor(() => {
      expect(FakeTextLayer.updateCount).toBeGreaterThanOrEqual(1);
    });

    const textAfterNew = snapshotContainer(textEl);
    const linkAfterNew = snapshotContainer(linkEl);
    const wrapper = document.querySelector(".gno-pdf-page") as HTMLElement;
    const wrapperSnap = wrapperScale(wrapper);

    // OLD text resolves LAST
    await act(async () => {
      docOld._releaseText({ items: [{ str: "STALE-TEXT" }], styles: {} });
      await Promise.resolve();
      await Promise.resolve();
    });

    // Old boundary correctly never constructed; NEW owns lifecycle
    expect(FakeTextLayer.constructorCount).toBe(1);
    expect(FakeTextLayer.renderCount).toBe(1);
    expect(FakeTextLayer.updateCount).toBeGreaterThanOrEqual(1);
    expect(FakeTextLayer.instances[0]!.cancelled).toBe(false);

    expectSnapshotUnchanged(textEl, textAfterNew, "text after old textContent");
    expectSnapshotUnchanged(linkEl, linkAfterNew, "link after old textContent");
    expect(wrapperScale(wrapper).scaleFactor).toBe(wrapperSnap.scaleFactor);
    expect(textEl.textContent ?? "").not.toContain("STALE-TEXT");
    expect(onInternal).not.toHaveBeenCalled();
    void oldProbeSnap;
  });

  test("I3-03: same-component identity replace — deferred TextLayer.render OLD-last", async () => {
    FakeTextLayer.holdNextRender = true;
    const docOld = makeControlledDoc(1);
    const onInternal = mock(() => undefined);

    const { rerender } = render(
      <PdfPageView
        active
        doc={docOld as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={1}
        rendered
        scale={1}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );

    await waitFor(() => {
      expect(FakeTextLayer.constructorCount).toBe(1);
      expect(FakeTextLayer.renderCount).toBe(1);
    });
    const oldLayer = FakeTextLayer.instances[0]!;

    const textEl = document.querySelector(".gno-pdf-text-layer") as HTMLElement;
    const linkEl = document.querySelector(
      ".gno-pdf-annotation-layer"
    ) as HTMLElement;
    const wrapper = document.querySelector(".gno-pdf-page") as HTMLElement;
    expect(textEl.dataset.owner).toBe("layer-0");

    // Identity replace while old render held — NEW constructs+renders immediately
    const docNew = makeControlledDoc(2);
    rerender(
      <PdfPageView
        active
        doc={docNew as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={2}
        rendered
        scale={1}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );

    await waitFor(() => {
      expect(oldLayer.cancelled).toBe(true);
      expect(FakeTextLayer.cancelCount).toBeGreaterThanOrEqual(1);
      expect(FakeTextLayer.constructorCount).toBe(2);
      expect(FakeTextLayer.renderCount).toBeGreaterThanOrEqual(2);
    });

    const newLayer = FakeTextLayer.instances[1]!;
    expect(newLayer).not.toBe(oldLayer);
    expect(newLayer.cancelled).toBe(false);

    // Zoom new identity → update
    rerender(
      <PdfPageView
        active
        doc={docNew as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={2}
        rendered
        scale={2.5}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );
    await waitFor(() => {
      expect(FakeTextLayer.updateCount).toBeGreaterThanOrEqual(1);
    });
    expect(FakeTextLayer.constructorCount).toBe(2);

    const textAfterNew = snapshotContainer(textEl);
    const linkAfterNew = snapshotContainer(linkEl);
    const wrapAfterNew = wrapperScale(wrapper);

    // OLD render settles LAST (also unblocked by cancel)
    await act(async () => {
      oldLayer.settleRender();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textEl.textContent ?? "").not.toContain("STALE-CHILD");
    expect(textEl.dataset.owner).not.toBe("stale-finished");
    expectSnapshotUnchanged(textEl, textAfterNew, "text after old render");
    expectSnapshotUnchanged(linkEl, linkAfterNew, "link after old render");
    expect(wrapperScale(wrapper).scaleFactor).toBe(wrapAfterNew.scaleFactor);
    expect(newLayer.cancelled).toBe(false);
    expect(FakeTextLayer.cancelCount).toBeGreaterThanOrEqual(1);
    expect(FakeTextLayer.constructorCount).toBe(2);
    expect(FakeTextLayer.renderCount).toBeGreaterThanOrEqual(2);
    expect(FakeTextLayer.updateCount).toBeGreaterThanOrEqual(1);
    expect(onInternal).not.toHaveBeenCalled();
  });

  test("I3-03: same-component identity replace — deferred OLD getDestination after real click", async () => {
    const onInternal = mock(() => undefined);
    // OLD fully builds an internal link; getDestination holds once clicked.
    const docOld = makeControlledDoc(1, {
      holdDest: true,
      annots: [
        {
          subtype: "Link",
          rect: [10, 700, 100, 720],
          dest: "old-dest",
        },
      ],
    });

    const { rerender } = render(
      <PdfPageView
        active
        doc={docOld as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={1}
        rendered
        scale={1}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );

    await waitFor(() => {
      expect(FakeTextLayer.constructorCount).toBe(1);
      expect(FakeTextLayer.renderCount).toBe(1);
      expect(
        document.querySelector('[data-annotation="internal"]')
      ).toBeTruthy();
    });

    const textEl = document.querySelector(".gno-pdf-text-layer") as HTMLElement;
    const linkEl = document.querySelector(
      ".gno-pdf-annotation-layer"
    ) as HTMLElement;
    const wrapper = document.querySelector(".gno-pdf-page") as HTMLElement;

    // Capture OLD-owned DOM before transition
    const textOldOwned = snapshotContainer(textEl);
    const linkOldOwned = snapshotContainer(linkEl);
    expect(linkOldOwned.childCount).toBeGreaterThan(0);

    // Click OLD internal link → getDestination must be invoked and pending
    const pageIndexBeforeClick = docOld._ctl.getPageIndexCalls;
    await act(async () => {
      (
        document.querySelector(
          '[data-annotation="internal"]'
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(docOld._ctl.getDestCalls).toBeGreaterThan(0);
    });
    // Destination still pending → pageIndex not yet called
    expect(docOld._ctl.getPageIndexCalls).toBe(pageIndexBeforeClick);
    expect(docOld._ctl.destHold).toBeTruthy();

    // Same-component identity replace while dest is pending
    const docNew = makeControlledDoc(2, {
      annots: [
        {
          subtype: "Link",
          rect: [10, 650, 100, 670],
          url: "https://example.com/new-only",
        },
      ],
    });
    rerender(
      <PdfPageView
        active
        doc={docNew as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={2}
        rendered
        scale={1}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );

    await waitFor(() => {
      expect(FakeTextLayer.constructorCount).toBe(2);
      expect(FakeTextLayer.renderCount).toBe(2);
      expect(
        document.querySelector('[data-annotation="external"]')
      ).toBeTruthy();
    });
    // OLD internal link replaced by NEW external
    expect(
      document.querySelectorAll('[data-annotation="internal"]').length
    ).toBe(0);

    // Compatible zoom on NEW → update
    rerender(
      <PdfPageView
        active
        doc={docNew as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={2}
        rendered
        scale={2}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );
    await waitFor(() => {
      expect(FakeTextLayer.updateCount).toBeGreaterThanOrEqual(1);
    });

    const textAfterNew = snapshotContainer(textEl);
    const linkAfterNew = snapshotContainer(linkEl);
    const wrapAfterNew = wrapperScale(wrapper);
    const navBefore = onInternal.mock.calls.length;
    const destCallsAtTransition = docOld._ctl.getDestCalls;
    const pageIndexAtTransition = docOld._ctl.getPageIndexCalls;

    // OLD getDestination completes LAST
    await act(async () => {
      docOld._releaseDest([{ num: 9, gen: 0 }]);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Must not proceed to getPageIndex or navigation after identity replace
    expect(docOld._ctl.getPageIndexCalls).toBe(pageIndexAtTransition);
    expect(docOld._ctl.getDestCalls).toBe(destCallsAtTransition);
    expect(onInternal.mock.calls.length).toBe(navBefore);
    expect(onInternal).not.toHaveBeenCalled();

    // NEW DOM ownership unchanged by OLD-last dest
    expectSnapshotUnchanged(textEl, textAfterNew, "text after old dest");
    expectSnapshotUnchanged(linkEl, linkAfterNew, "link after old dest");
    expect(wrapperScale(wrapper).scaleFactor).toBe(wrapAfterNew.scaleFactor);
    expect(
      document.querySelectorAll('[data-annotation="internal"]').length
    ).toBe(0);

    // Explicit lifecycle: OLD constructed once, NEW once, cancel of OLD layer, update on NEW
    expect(FakeTextLayer.constructorCount).toBe(2);
    expect(FakeTextLayer.renderCount).toBe(2);
    expect(FakeTextLayer.cancelCount).toBeGreaterThanOrEqual(1);
    expect(FakeTextLayer.updateCount).toBeGreaterThanOrEqual(1);
    // OLD owned containers were real (pre-transition proof)
    expect(textOldOwned.owner).toBe("layer-0");
    expect(linkOldOwned.childCount).toBeGreaterThan(0);
  });

  test("I3-03: same-component identity replace — deferred OLD getPageIndex after real click", async () => {
    const onInternal = mock(() => undefined);
    // Destination resolves with a real page ref; pageIndex holds after click.
    const docOld = makeControlledDoc(1, {
      holdPageIndex: true,
      annots: [
        {
          subtype: "Link",
          rect: [10, 700, 100, 720],
          dest: "old-dest",
        },
      ],
    });

    const { rerender } = render(
      <PdfPageView
        active
        doc={docOld as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={1}
        rendered
        scale={1}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );

    await waitFor(() => {
      expect(FakeTextLayer.renderCount).toBe(1);
      expect(
        document.querySelector('[data-annotation="internal"]')
      ).toBeTruthy();
    });

    const textEl = document.querySelector(".gno-pdf-text-layer") as HTMLElement;
    const linkEl = document.querySelector(
      ".gno-pdf-annotation-layer"
    ) as HTMLElement;
    const wrapper = document.querySelector(".gno-pdf-page") as HTMLElement;
    const textOldOwned = snapshotContainer(textEl);
    const linkOldOwned = snapshotContainer(linkEl);

    // Click OLD link → getDestination resolves non-vacuously, getPageIndex pending
    await act(async () => {
      (
        document.querySelector(
          '[data-annotation="internal"]'
        ) as HTMLButtonElement
      ).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(docOld._ctl.getDestCalls).toBeGreaterThan(0);
      expect(docOld._ctl.getPageIndexCalls).toBeGreaterThan(0);
    });
    expect(docOld._ctl.pageIndexHold).toBeTruthy();
    expect(onInternal).not.toHaveBeenCalled();

    // Same-component replace while pageIndex pending
    const docNew = makeControlledDoc(2, {
      annots: [
        {
          subtype: "Link",
          rect: [10, 650, 100, 670],
          url: "https://example.com/new-only",
        },
      ],
    });
    rerender(
      <PdfPageView
        active
        doc={docNew as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={2}
        rendered
        scale={1}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );

    await waitFor(() => {
      expect(FakeTextLayer.constructorCount).toBe(2);
      expect(
        document.querySelector('[data-annotation="external"]')
      ).toBeTruthy();
    });

    rerender(
      <PdfPageView
        active
        doc={docNew as never}
        height={300}
        onInternalNavigate={onInternal}
        onMount={() => undefined}
        onRender={() => undefined}
        pageNumber={2}
        rendered
        scale={2}
        TextLayerImpl={FakeTextLayer as never}
        sanitizeAnnotationUrl={sanitizeAnnotationUrl as never}
        width={200}
      />
    );
    await waitFor(() => {
      expect(FakeTextLayer.updateCount).toBeGreaterThanOrEqual(1);
    });

    const textAfterNew = snapshotContainer(textEl);
    const linkAfterNew = snapshotContainer(linkEl);
    const wrapAfterNew = wrapperScale(wrapper);
    const navBefore = onInternal.mock.calls.length;
    const pageIndexAtTransition = docOld._ctl.getPageIndexCalls;
    const destAtTransition = docOld._ctl.getDestCalls;

    // OLD getPageIndex completes LAST
    await act(async () => {
      docOld._releasePageIndex(8);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Navigation must remain zero; no further dest/pageIndex from OLD path
    expect(onInternal.mock.calls.length).toBe(navBefore);
    expect(onInternal).not.toHaveBeenCalled();
    expect(docOld._ctl.getPageIndexCalls).toBe(pageIndexAtTransition);
    expect(docOld._ctl.getDestCalls).toBe(destAtTransition);

    expectSnapshotUnchanged(textEl, textAfterNew, "text after old pageIndex");
    expectSnapshotUnchanged(linkEl, linkAfterNew, "link after old pageIndex");
    expect(wrapperScale(wrapper).scaleFactor).toBe(wrapAfterNew.scaleFactor);
    expect(
      document.querySelectorAll('[data-annotation="internal"]').length
    ).toBe(0);

    expect(FakeTextLayer.constructorCount).toBe(2);
    expect(FakeTextLayer.renderCount).toBe(2);
    expect(FakeTextLayer.cancelCount).toBeGreaterThanOrEqual(1);
    expect(FakeTextLayer.updateCount).toBeGreaterThanOrEqual(1);
    expect(textOldOwned.owner).toBe("layer-0");
    expect(linkOldOwned.childCount).toBeGreaterThan(0);
  });

  test("pdfjs-dist is imported only from lib/pdf.ts facade", () => {
    const root = join(import.meta.dir, "../../../../../src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
          if (name === "node_modules" || name === "dist") continue;
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/u.test(name)) continue;
        const text = readFileSync(p, "utf8");
        if (
          /from\s+['"]pdfjs-dist/.test(text) ||
          /require\(['"]pdfjs-dist/.test(text)
        ) {
          hits.push(p);
        }
      }
    };
    walk(root);
    const rel = hits.map((h) => h.replace(/.*\/src\//u, "src/"));
    expect(rel).toEqual(["src/serve/public/lib/pdf.ts"]);
  });
});
