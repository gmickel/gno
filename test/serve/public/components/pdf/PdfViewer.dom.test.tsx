import type { ReactNode } from "react";

import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { UsePdfDocumentResult } from "../../../../../src/serve/public/hooks/use-pdf-document";
import type {
  PageSlotState,
  UsePdfPagesOptions,
  UsePdfPagesResult,
} from "../../../../../src/serve/public/hooks/use-pdf-pages";

import {
  createDocumentHookWithDeps,
  createPagesHookWithDeps,
  PdfViewerTestDepsProvider,
  type PdfViewerDocumentHook,
  type PdfViewerPagesHook,
} from "../../../../../src/serve/public/components/pdf/pdf-viewer-deps";
import { PdfViewer } from "../../../../../src/serve/public/components/pdf/PdfViewer";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  type GnoDocumentLoadingTask,
  type GnoGetDocumentParams,
  type PdfFallbackReason,
} from "../../../../../src/serve/public/lib/pdf";

// ── Unit-style stubs (via internal TestDepsProvider only) ───────────────────

type DocStub = {
  status: UsePdfDocumentResult["status"];
  doc: unknown;
  numPages: number;
  firstPageReady: boolean;
  error: PdfFallbackReason | null;
  errorMessage: string | null;
  docId: string | null;
  retry: ReturnType<typeof mock>;
};

function makeFakeDoc(numPages: number) {
  return {
    numPages,
    getPage: async (n: number) => ({
      pageNumber: n,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 200 * scale,
        height: 280 * scale,
        scale,
        convertToViewportPoint: (x: number, y: number) => [x, y],
      }),
      getTextContent: async () => ({ items: [], styles: {} }),
      getAnnotations: async () => [],
      cleanup: () => undefined,
      render: () => ({
        promise: Promise.resolve(),
        cancel: () => undefined,
      }),
    }),
  };
}

function makeDocStub(partial: Partial<DocStub> = {}): DocStub {
  const numPages = partial.numPages ?? 3;
  return {
    status: "ready",
    doc: makeFakeDoc(numPages),
    numPages,
    firstPageReady: numPages > 0,
    error: null,
    errorMessage: null,
    docId: "d1",
    retry: mock(() => undefined),
    ...partial,
  };
}

function makeSlots(numPages: number, rendered: Set<number>): PageSlotState[] {
  const slots: PageSlotState[] = [];
  for (let i = 1; i <= numPages; i++) {
    slots.push({
      pageNumber: i,
      width: 200,
      height: 280,
      rendered: rendered.has(i),
      visible: i <= 2,
      active: i <= 2,
    });
  }
  return slots;
}

function makePagesResult(
  opts: UsePdfPagesOptions,
  rendered: Set<number> = new Set([1])
): UsePdfPagesResult {
  return {
    slots: makeSlots(opts.numPages, rendered),
    error: null,
    liveCanvasCount: rendered.size,
    observePage: mock(() => undefined),
    ensureRendered: mock(async () => undefined),
    scale: opts.zoom,
    disposeAll: mock(async () => undefined),
  };
}

function stubDocumentHook(doc: DocStub): PdfViewerDocumentHook {
  return () => ({
    status: doc.status,
    doc: doc.doc as never,
    numPages: doc.numPages,
    firstPageReady: doc.firstPageReady,
    error: doc.error,
    errorMessage: doc.errorMessage,
    docId: doc.docId,
    retry: doc.retry as () => void,
  });
}

function stubPagesHook(
  factory: (o: UsePdfPagesOptions) => UsePdfPagesResult = (o) =>
    makePagesResult(o, new Set([1]))
): PdfViewerPagesHook {
  return factory;
}

function renderWithDeps(
  ui: ReactNode,
  deps: {
    usePdfDocument?: PdfViewerDocumentHook;
    usePdfPages?: PdfViewerPagesHook;
  }
) {
  return render(
    <PdfViewerTestDepsProvider deps={deps}>{ui}</PdfViewerTestDepsProvider>
  );
}

function assertNoCardChrome(el: HTMLElement): void {
  const cls = el.className;
  // Flat well treatment: no rounded/bordered/tinted Card surface
  expect(cls).not.toMatch(/\brounded(-[a-z0-9]+)?\b/);
  expect(cls).not.toMatch(/\bborder(-[a-z0-9/]+)?\b/);
  expect(cls).not.toMatch(/\bbg-muted\b/);
  expect(cls).not.toMatch(/\bbg-card\b/);
  expect(cls).not.toMatch(/\bshadow(-[a-z0-9]+)?\b/);
}

// ── Integration helpers: real usePdfDocument lower-level seam ───────────────

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

type MetricEvent = {
  seq: number;
  t: number;
  kind: string;
  docId?: string;
  pageNumber?: number | null;
  taskId?: string | null;
  genId?: number | null;
  outcome?: string | null;
  scale?: number | null;
};

describe("PdfViewer", () => {
  afterEach(() => {
    cleanup();
  });

  function renderViewer(args: {
    doc: DocStub;
    extractedTextAvailable?: boolean;
    onFallback?: ReturnType<typeof mock>;
    pagesFactory?: (o: UsePdfPagesOptions) => UsePdfPagesResult;
    assetUrl?: string | null;
  }) {
    const onFallback = args.onFallback ?? mock(() => undefined);
    const pagesFactory =
      args.pagesFactory ??
      ((o: UsePdfPagesOptions) => makePagesResult(o, new Set([1])));

    const view = renderWithDeps(
      <PdfViewer
        assetUrl={args.assetUrl ?? "/asset.pdf"}
        downloadUrl="/download.pdf"
        extractedTextAvailable={args.extractedTextAvailable ?? false}
        onFallback={onFallback as (r: PdfFallbackReason) => void}
      />,
      {
        usePdfDocument: stubDocumentHook(args.doc),
        usePdfPages: stubPagesHook(pagesFactory),
      }
    );
    return { view, onFallback, doc: args.doc };
  }

  test("production PdfViewerProps expose only the four contract keys", () => {
    // Compile-time contract is the type; runtime: no injection attrs on element
    const onFallback = mock(() => undefined);
    render(
      <PdfViewer
        assetUrl="/a.pdf"
        downloadUrl="/d.pdf"
        extractedTextAvailable={false}
        onFallback={onFallback}
      />
    );
    // Without provider + url load may error — still mounts with exact props
    expect(screen.getByTestId("pdf-viewer")).toBeTruthy();
    // Type surface check via assignment (fails tsc if extra required props)
    const props: import("../../../../../src/serve/public/components/pdf/PdfViewer").PdfViewerProps =
      {
        assetUrl: null,
        downloadUrl: "/d",
        extractedTextAvailable: false,
        onFallback: () => undefined,
      };
    expect(Object.keys(props).sort()).toEqual(
      ["assetUrl", "downloadUrl", "extractedTextAvailable", "onFallback"].sort()
    );
  });

  test("loading state exact copy, role=status, no Card chrome", () => {
    renderViewer({
      doc: makeDocStub({
        status: "loading",
        firstPageReady: false,
        numPages: 0,
        doc: null,
      }),
    });
    const panel = screen.getByTestId("pdf-state-loading");
    expect(panel.getAttribute("role")).toBe("status");
    expect(panel.textContent).toContain("LOADING");
    expect(panel.textContent).toContain("Preparing document…");
    assertNoCardChrome(panel);
    expect(
      document.querySelectorAll('[data-testid^="pdf-state-"]')
    ).toHaveLength(1);
  });

  test("empty state exact copy, download action, no Card chrome", () => {
    renderViewer({
      doc: makeDocStub({
        status: "ready",
        firstPageReady: false, // real hook: zero-page ⇒ firstPageReady false
        numPages: 0,
      }),
    });
    const panel = screen.getByTestId("pdf-state-empty");
    expect(panel.getAttribute("role")).toBe("status");
    expect(panel.textContent).toContain("EMPTY DOCUMENT");
    expect(panel.textContent).toContain("This PDF has no pages.");
    assertNoCardChrome(panel);
    expect(screen.getByTestId("pdf-action-download").textContent).toContain(
      "Download original"
    );
    expect(screen.queryByTestId("pdf-action-retry")).toBeNull();
    // Document controls disabled; download remains
    expect(
      (screen.getByTestId("pdf-toolbar-prev") as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByTestId("pdf-toolbar-zoom-in") as HTMLButtonElement).disabled
    ).toBe(true);
  });

  test.each([
    [
      "corrupt",
      "pdf-state-corrupt",
      "CANNOT RENDER",
      "This PDF could not be rendered. Download the original to read it.",
      true,
    ],
    [
      "password",
      "pdf-state-password",
      "PASSWORD PROTECTED",
      "This PDF is password protected. Download the original to open it in a PDF reader.",
      false,
    ],
    [
      "network",
      "pdf-state-network",
      "COULD NOT LOAD",
      "The document could not be loaded from this session. Try again, or download the original.",
      true,
    ],
    [
      "bootstrap",
      "pdf-state-bootstrap",
      "VIEWER UNAVAILABLE",
      "The PDF viewer could not start in this window. Download the original to read it.",
      true,
    ],
  ] as const)(
    "error state %s exact copy, role=alert, no Card chrome",
    (reason, testId, eyebrow, body, hasRetry) => {
      const doc = makeDocStub({
        status: "error",
        error: reason,
        firstPageReady: false,
        numPages: 0,
        doc: null,
      });
      renderViewer({ doc, extractedTextAvailable: false });
      const panel = screen.getByTestId(testId);
      expect(panel.getAttribute("role")).toBe("alert");
      expect(panel.textContent).toContain(eyebrow);
      expect(panel.textContent).toContain(body);
      assertNoCardChrome(panel);
      if (hasRetry) {
        expect(screen.getByTestId("pdf-action-retry").textContent).toContain(
          "Try again"
        );
      } else {
        expect(screen.queryByTestId("pdf-action-retry")).toBeNull();
      }
      expect(screen.getByTestId("pdf-action-download").textContent).toContain(
        "Download original"
      );
    }
  );

  test("onFallback fires once per failed load when extractedTextAvailable true", () => {
    const onFallback = mock(() => undefined);
    const doc = makeDocStub({
      status: "error",
      error: "corrupt",
      docId: "d-fail-1",
      firstPageReady: false,
      numPages: 0,
      doc: null,
    });
    const { view } = renderViewer({
      doc,
      extractedTextAvailable: true,
      onFallback,
    });
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith("corrupt");
    expect(screen.queryByTestId("pdf-state-corrupt")).toBeNull();

    view.rerender(
      <PdfViewerTestDepsProvider
        deps={{
          usePdfDocument: stubDocumentHook(doc),
          usePdfPages: stubPagesHook(),
        }}
      >
        <PdfViewer
          assetUrl="/asset.pdf"
          downloadUrl="/download.pdf"
          extractedTextAvailable
          onFallback={onFallback as (r: PdfFallbackReason) => void}
        />
      </PdfViewerTestDepsProvider>
    );
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  test("onFallback for all four reasons once each; false never fires and keeps panel", () => {
    for (const reason of [
      "corrupt",
      "password",
      "network",
      "bootstrap",
    ] as const) {
      cleanup();
      const onFallback = mock(() => undefined);
      const doc = makeDocStub({
        status: "error",
        error: reason,
        docId: `d-${reason}`,
        firstPageReady: false,
        numPages: 0,
        doc: null,
      });
      renderViewer({ doc, extractedTextAvailable: true, onFallback });
      expect(onFallback).toHaveBeenCalledTimes(1);
      expect(onFallback).toHaveBeenCalledWith(reason);
      expect(
        document.querySelectorAll('[data-testid^="pdf-state-"]')
      ).toHaveLength(0);
    }

    cleanup();
    const onFallback = mock(() => undefined);
    renderViewer({
      doc: makeDocStub({
        status: "error",
        error: "network",
        docId: "d-no-text",
        firstPageReady: false,
        numPages: 0,
        doc: null,
      }),
      extractedTextAvailable: false,
      onFallback,
    });
    expect(onFallback).not.toHaveBeenCalled();
    expect(screen.getByTestId("pdf-state-network")).toBeTruthy();
  });

  test("progressive: page column with rendered and unrendered pages, zero state cards", () => {
    renderViewer({
      doc: makeDocStub({ numPages: 4, firstPageReady: true, status: "ready" }),
      pagesFactory: (o) => makePagesResult(o, new Set([1, 2])),
    });
    expect(screen.getByTestId("pdf-page-column")).toBeTruthy();
    expect(screen.getByTestId("pdf-page-1").getAttribute("data-rendered")).toBe(
      "true"
    );
    expect(screen.getByTestId("pdf-page-3").getAttribute("data-rendered")).toBe(
      "false"
    );
    expect(
      document.querySelectorAll('[data-testid^="pdf-state-"]')
    ).toHaveLength(0);
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("object")).toBeNull();
    expect(document.querySelector("embed")).toBeNull();
  });

  test("toolbar zoom/fit commits bump gen (stub pages records increasing genId)", () => {
    const genIds: number[] = [];
    renderViewer({
      doc: makeDocStub(),
      pagesFactory: (o) => {
        genIds.push(o.genId);
        return makePagesResult(o, new Set([1]));
      },
    });
    const baseline = genIds.at(-1) ?? 1;
    fireEvent.click(screen.getByTestId("pdf-toolbar-zoom-in"));
    expect(genIds.at(-1)!).toBeGreaterThan(baseline);
    const afterZoom = genIds.at(-1)!;
    fireEvent.click(screen.getByTestId("pdf-toolbar-fit-page"));
    expect(genIds.at(-1)!).toBeGreaterThan(afterZoom);
    // Reason for change: the percentage readout button became the zoom-level
    // combobox (task .6 R4/R5 addendum), so reset-to-100% is exercised through
    // its preserved keyboard shortcut rather than a click on the readout.
    fireEvent.keyDown(screen.getByTestId("pdf-viewer"), { key: "0" });
    expect(
      screen.getByTestId("pdf-toolbar-fit-width").getAttribute("aria-pressed")
    ).toBe("false");
    expect(
      screen.getByTestId("pdf-toolbar-fit-page").getAttribute("aria-pressed")
    ).toBe("false");
  });

  test("zoom-level combobox commits zoom + custom fit + exactly one gen bump; no bump when already current", async () => {
    const genIds: number[] = [];
    renderViewer({
      doc: makeDocStub(),
      pagesFactory: (o) => {
        genIds.push(o.genId);
        return makePagesResult(o, new Set([1]));
      },
    });
    const baseline = genIds.at(-1) ?? 1;

    fireEvent.keyDown(screen.getByTestId("pdf-toolbar-zoom-level"), {
      key: "Enter",
    });
    fireEvent.click(await screen.findByTestId("pdf-toolbar-zoom-option-200"));

    await waitFor(() => {
      expect(genIds.at(-1)!).toBeGreaterThan(baseline);
    });
    const afterSelect = genIds.at(-1)!;
    expect(screen.getByTestId("pdf-toolbar-zoom-level").textContent).toContain(
      "200%"
    );
    // Committing zoom leaves both fit toggles unpressed (fitMode === custom).
    expect(
      screen.getByTestId("pdf-toolbar-fit-width").getAttribute("aria-pressed")
    ).toBe("false");
    expect(
      screen.getByTestId("pdf-toolbar-fit-page").getAttribute("aria-pressed")
    ).toBe("false");

    // Re-selecting the already-current level is a no-op: no further gen bump.
    fireEvent.keyDown(screen.getByTestId("pdf-toolbar-zoom-level"), {
      key: "Enter",
    });
    fireEvent.click(await screen.findByTestId("pdf-toolbar-zoom-option-200"));
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(genIds.at(-1)!).toBe(afterSelect);
  });

  test("keyboard: handled keys preventDefault and change state; unhandled do not", () => {
    renderViewer({ doc: makeDocStub({ numPages: 5 }) });
    const viewer = screen.getByTestId("pdf-viewer");
    viewer.focus();

    const eRight = createEvent.keyDown(viewer, { key: "ArrowRight" });
    fireEvent(viewer, eRight);
    expect(eRight.defaultPrevented).toBe(true);
    expect(
      screen.getByTestId("pdf-toolbar-page-indicator").textContent
    ).toMatch(/2/);

    const eUp = createEvent.keyDown(viewer, { key: "ArrowUp" });
    fireEvent(viewer, eUp);
    expect(eUp.defaultPrevented).toBe(false);

    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByTestId("pdf-toolbar-next"));
    }
    const eEnd = createEvent.keyDown(viewer, { key: "ArrowRight" });
    fireEvent(viewer, eEnd);
    expect(eEnd.defaultPrevented).toBe(false);

    fireEvent.click(screen.getByTestId("pdf-toolbar-prev"));
    const eZoom = createEvent.keyDown(viewer, { key: "+" });
    fireEvent(viewer, eZoom);
    expect(eZoom.defaultPrevented).toBe(true);

    const input = screen.getByTestId("pdf-toolbar-page-input");
    const pageBefore = screen.getByTestId(
      "pdf-toolbar-page-indicator"
    ).textContent;
    const eInInput = createEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent(input, eInInput);
    expect(eInInput.defaultPrevented).toBe(false);
    expect(screen.getByTestId("pdf-toolbar-page-indicator").textContent).toBe(
      pageBefore
    );
  });

  test("keyboard at MIN/MAX zoom does not preventDefault or change state", () => {
    const genIds: number[] = [];
    // Drive zoom via repeated + until max using real viewer state
    renderViewer({
      doc: makeDocStub({ numPages: 2 }),
      pagesFactory: (o) => {
        genIds.push(o.genId);
        return makePagesResult(o, new Set([1]));
      },
    });
    const viewer = screen.getByTestId("pdf-viewer");
    viewer.focus();

    // Zoom all the way to MAX
    for (let i = 0; i < 50; i++) {
      fireEvent.keyDown(viewer, { key: "+" });
    }
    expect(screen.getByTestId("pdf-toolbar-zoom-level").textContent).toContain(
      `${Math.round(MAX_ZOOM * 100)}%`
    );
    const genAtMax = genIds.at(-1)!;
    const ePlus = createEvent.keyDown(viewer, { key: "+" });
    fireEvent(viewer, ePlus);
    expect(ePlus.defaultPrevented).toBe(false);
    expect(genIds.at(-1)).toBe(genAtMax);

    // Zoom all the way to MIN
    for (let i = 0; i < 50; i++) {
      fireEvent.keyDown(viewer, { key: "-" });
    }
    expect(screen.getByTestId("pdf-toolbar-zoom-level").textContent).toContain(
      `${Math.round(MIN_ZOOM * 100)}%`
    );
    const genAtMin = genIds.at(-1)!;
    const eMinus = createEvent.keyDown(viewer, { key: "-" });
    fireEvent(viewer, eMinus);
    expect(eMinus.defaultPrevented).toBe(false);
    expect(genIds.at(-1)).toBe(genAtMin);
  });

  test("no view toggle; cursor-pointer on actions", () => {
    renderViewer({
      doc: makeDocStub({
        status: "error",
        error: "corrupt",
        firstPageReady: false,
        numPages: 0,
        doc: null,
      }),
      extractedTextAvailable: false,
    });
    expect(
      document.querySelector('[data-testid="pdf-view-toggle"]')
    ).toBeNull();
    expect(screen.queryByText(/^Pages$/)).toBeNull();
    const retry = screen.getByTestId("pdf-action-retry");
    expect(retry.className).toContain("cursor-pointer");
  });

  test("password has no retry; retry invokes doc.retry", () => {
    const doc = makeDocStub({
      status: "error",
      error: "password",
      firstPageReady: false,
      numPages: 0,
      doc: null,
    });
    renderViewer({ doc, extractedTextAvailable: false });
    expect(screen.queryByTestId("pdf-action-retry")).toBeNull();

    cleanup();
    const doc2 = makeDocStub({
      status: "error",
      error: "network",
      firstPageReady: false,
      numPages: 0,
      doc: null,
    });
    renderViewer({ doc: doc2, extractedTextAvailable: false });
    fireEvent.click(screen.getByTestId("pdf-action-retry"));
    expect(doc2.retry).toHaveBeenCalled();
  });

  test("page acquisition errors use the same designed panel and fallback path", () => {
    const pagesFactory = (options: UsePdfPagesOptions): UsePdfPagesResult => ({
      ...makePagesResult(options),
      slots: [],
      error: "password",
    });
    renderViewer({ doc: makeDocStub(), pagesFactory });
    expect(screen.getByTestId("pdf-state-password")).toBeTruthy();

    cleanup();
    const onFallback = mock(() => undefined);
    renderViewer({
      doc: makeDocStub(),
      pagesFactory,
      extractedTextAvailable: true,
      onFallback,
    });
    expect(onFallback).toHaveBeenCalledWith("password");
    expect(screen.queryByTestId("pdf-state-password")).toBeNull();
  });

  test("viewer is focusable with aria-label", () => {
    renderViewer({ doc: makeDocStub() });
    const viewer = screen.getByTestId("pdf-viewer");
    expect(viewer.getAttribute("tabindex")).toBe("0");
    expect(viewer.getAttribute("aria-label")).toBe("PDF viewer");
  });

  test("page navigation respects prefers-reduced-motion for scroll behavior", async () => {
    const scrollCalls: Array<{ behavior?: ScrollBehavior }> = [];
    const proto = HTMLElement.prototype as HTMLElement & {
      scrollIntoView: (
        this: HTMLElement,
        arg?: boolean | ScrollIntoViewOptions
      ) => void;
    };
    const originalScroll = proto.scrollIntoView.bind(proto);
    proto.scrollIntoView = function scrollIntoViewStub(
      this: HTMLElement,
      arg?: boolean | ScrollIntoViewOptions
    ) {
      if (typeof arg === "object" && arg !== null) {
        scrollCalls.push({ behavior: arg.behavior });
      } else {
        scrollCalls.push({});
      }
    };

    const originalMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) => {
      return {
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      };
    }) as typeof window.matchMedia;

    try {
      renderViewer({ doc: makeDocStub({ numPages: 4 }) });
      fireEvent.click(screen.getByTestId("pdf-toolbar-next"));
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      expect(scrollCalls.length).toBeGreaterThan(0);
      expect(scrollCalls.some((c) => c.behavior === "auto")).toBe(true);
      expect(scrollCalls.every((c) => c.behavior !== "smooth")).toBe(true);
    } finally {
      proto.scrollIntoView = originalScroll;
      window.matchMedia = originalMatchMedia;
    }
  });

  test("visible page changes keep toolbar and next-page navigation synchronized", async () => {
    let visiblePage = 1;
    const pagesFactory = (options: UsePdfPagesOptions): UsePdfPagesResult => {
      const result = makePagesResult(options, new Set([1, 2, 3, 4]));
      return {
        ...result,
        slots: result.slots.map((slot) => ({
          ...slot,
          visible: slot.pageNumber === visiblePage,
        })),
      };
    };
    const doc = makeDocStub({ numPages: 4 });
    const renderTree = () => (
      <PdfViewerTestDepsProvider
        deps={{
          usePdfDocument: stubDocumentHook(doc),
          usePdfPages: stubPagesHook(pagesFactory),
        }}
      >
        <PdfViewer
          assetUrl="/asset.pdf"
          downloadUrl="/download.pdf"
          extractedTextAvailable={false}
          onFallback={() => undefined}
        />
      </PdfViewerTestDepsProvider>
    );
    const view = render(renderTree());

    visiblePage = 3;
    view.rerender(renderTree());
    await waitFor(() => {
      expect(screen.getByTestId("pdf-toolbar-page-indicator").textContent).toBe(
        "3 / 4"
      );
    });
    fireEvent.click(screen.getByTestId("pdf-toolbar-next"));
    expect(screen.getByTestId("pdf-toolbar-page-indicator").textContent).toBe(
      "4 / 4"
    );
  });

  test("internal PDF annotations navigate through the viewer callback", async () => {
    const pageProxy = {
      pageNumber: 1,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 200 * scale,
        height: 280 * scale,
        scale,
        convertToViewportPoint: (x: number, y: number) => [x, y],
      }),
      getTextContent: async () => ({ items: [], styles: {} }),
      getAnnotations: async () => [
        {
          subtype: "Link",
          rect: [0, 0, 20, 20],
          dest: [{ num: 9, gen: 0 }],
        },
      ],
      cleanup: () => undefined,
      render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
    };
    const pdfDoc = {
      numPages: 3,
      getPage: async () => pageProxy,
      getDestination: async () => null,
      getPageIndex: async () => 2,
    };
    const doc = makeDocStub({ doc: pdfDoc, numPages: 3 });
    const previousScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView"
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => undefined,
    });
    try {
      renderViewer({ doc });
      const internal = await waitFor(() => {
        const node = document.querySelector(
          '[data-annotation="internal"]'
        ) as HTMLButtonElement | null;
        expect(node).not.toBeNull();
        return node as HTMLButtonElement;
      });
      fireEvent.click(internal);
      await waitFor(() => {
        expect(
          screen.getByTestId("pdf-toolbar-page-indicator").textContent
        ).toBe("3 / 3");
      });
    } finally {
      if (previousScrollIntoView) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          previousScrollIntoView
        );
      } else {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown })
          .scrollIntoView;
      }
    }
  });

  test("keyboard 0 resets zoom to custom 100%; already-reset does not preventDefault", () => {
    renderViewer({ doc: makeDocStub({ numPages: 3 }) });
    const viewer = screen.getByTestId("pdf-viewer");
    viewer.focus();

    const ePlus = createEvent.keyDown(viewer, { key: "+" });
    fireEvent(viewer, ePlus);
    expect(ePlus.defaultPrevented).toBe(true);

    const eZero = createEvent.keyDown(viewer, { key: "0" });
    fireEvent(viewer, eZero);
    expect(eZero.defaultPrevented).toBe(true);
    expect(screen.getByTestId("pdf-toolbar-zoom-level").textContent).toContain(
      "100%"
    );
    expect(
      screen.getByTestId("pdf-toolbar-fit-width").getAttribute("aria-pressed")
    ).toBe("false");
    expect(
      screen.getByTestId("pdf-toolbar-fit-page").getAttribute("aria-pressed")
    ).toBe("false");

    const eZeroAgain = createEvent.keyDown(viewer, { key: "0" });
    fireEvent(viewer, eZeroAgain);
    expect(eZeroAgain.defaultPrevented).toBe(false);
  });

  // ── B1: real usePdfDocument zero-page integration ───────────────────────

  test("integration: real usePdfDocument loading → empty for zero-page proxy", async () => {
    type FakeDoc = {
      numPages: number;
      destroy: ReturnType<typeof mock>;
    };
    type FakeTask = {
      gnoDocId: string;
      deferred: Deferred<FakeDoc>;
      promise: Promise<FakeDoc>;
      destroy: ReturnType<typeof mock>;
      destroyed: boolean;
    };

    const tasks: FakeTask[] = [];
    let idN = 0;
    const metrics = {
      mintDocId: () => {
        idN += 1;
        return `zero-d${idN}`;
      },
      recordDocumentDestroy: mock(() => undefined),
    };

    function fakeGetDocument(
      _params: GnoGetDocumentParams
    ): GnoDocumentLoadingTask {
      const d = deferred<FakeDoc>();
      const task: FakeTask = {
        gnoDocId: metrics.mintDocId(),
        deferred: d,
        promise: d.promise,
        destroyed: false,
        destroy: mock(async () => {
          task.destroyed = true;
        }),
      };
      tasks.push(task);
      return task as unknown as GnoDocumentLoadingTask;
    }

    const onFallback = mock(() => undefined);
    renderWithDeps(
      <PdfViewer
        assetUrl="/zero.pdf"
        downloadUrl="/download-zero.pdf"
        extractedTextAvailable={false}
        onFallback={onFallback}
      />,
      {
        usePdfDocument: createDocumentHookWithDeps({
          getDocument: fakeGetDocument,
          getPdfMetrics: () => metrics as never,
        }),
        // Real usePdfPages default (zero pages → empty slots)
      }
    );

    // While unresolved: loading only
    expect(screen.getByTestId("pdf-state-loading")).toBeTruthy();
    expect(screen.queryByTestId("pdf-state-empty")).toBeNull();
    // Page roots are pdf-page-N (not pdf-page-column)
    expect(
      document.querySelectorAll(
        '[data-testid^="pdf-page-"]:not([data-testid="pdf-page-column"])'
      )
    ).toHaveLength(0);

    // Resolve real zero-page proxy: numPages 0, firstPageReady will be false
    await act(async () => {
      tasks.at(-1)!.deferred.resolve({
        numPages: 0,
        destroy: mock(async () => undefined),
      });
      await tasks.at(-1)!.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("pdf-state-empty")).toBeTruthy();
    });

    expect(screen.queryByTestId("pdf-state-loading")).toBeNull();
    expect(screen.getByTestId("pdf-state-empty").textContent).toContain(
      "EMPTY DOCUMENT"
    );
    expect(screen.getByTestId("pdf-state-empty").textContent).toContain(
      "This PDF has no pages."
    );
    assertNoCardChrome(screen.getByTestId("pdf-state-empty"));
    // No progressive pages; no contradiction with loading
    expect(
      document.querySelectorAll(
        '[data-testid^="pdf-page-"]:not([data-testid="pdf-page-column"])'
      )
    ).toHaveLength(0);
    expect(
      document.querySelectorAll('[data-testid^="pdf-state-"]')
    ).toHaveLength(1);

    // Document controls disabled; download actionable
    expect(
      (screen.getByTestId("pdf-toolbar-prev") as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByTestId("pdf-toolbar-next") as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByTestId("pdf-toolbar-zoom-in") as HTMLButtonElement).disabled
    ).toBe(true);
    const dl = screen.getByTestId("pdf-toolbar-download");
    const anchor = dl.matches("a") ? dl : dl.querySelector("a");
    expect((anchor as HTMLAnchorElement).getAttribute("href")).toBe(
      "/download-zero.pdf"
    );
    expect(onFallback).not.toHaveBeenCalled();
  });

  // ── B4-R2: real usePdfPages composition — event-driven gen/cancel ────────

  test("integration: viewer zoom gen commit reaches real usePdfPages cancel/metrics", async () => {
    type ControlledTask = {
      cancel: () => void;
      promise: Promise<void>;
      settle: () => void;
      cancelled: boolean;
      terminal: boolean;
    };

    /** Resolves once when predicate matches an appended metric event. */
    function waitForMetric(
      events: MetricEvent[],
      pred: (e: MetricEvent) => boolean
    ): Promise<MetricEvent> {
      const hit = events.find(pred);
      if (hit) {
        return Promise.resolve(hit);
      }
      return new Promise((resolve) => {
        waiters.push({ pred, resolve });
      });
    }

    const waiters: Array<{
      pred: (e: MetricEvent) => boolean;
      resolve: (e: MetricEvent) => void;
    }> = [];
    const events: MetricEvent[] = [];
    let seq = 0;
    let taskN = 0;
    const t0 = () =>
      typeof performance !== "undefined" ? performance.now() : Date.now();

    function pushEvent(
      partial: Omit<MetricEvent, "seq" | "t"> & {
        kind: string;
      }
    ): MetricEvent {
      seq += 1;
      const ev = { seq, t: t0(), ...partial } as MetricEvent;
      events.push(ev);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]!;
        if (w.pred(ev)) {
          waiters.splice(i, 1);
          w.resolve(ev);
        }
      }
      return ev;
    }

    const metrics = {
      mintDocId: () => "compose-d1",
      mintTaskId: () => {
        taskN += 1;
        return `rt${taskN}`;
      },
      bumpGen: () => 1,
      currentGen: () => 1,
      recordRenderStart: (a: Record<string, unknown>) => {
        pushEvent({ kind: "renderStart", ...a });
      },
      recordRenderCancel: (a: Record<string, unknown>) => {
        pushEvent({ kind: "renderCancel", ...a });
      },
      recordRenderSettle: (a: Record<string, unknown>) => {
        pushEvent({ kind: "renderSettle", ...a });
      },
      recordPageCleanup: (a: Record<string, unknown>) => {
        pushEvent({ kind: "pageCleanup", ...a });
      },
      recordDocumentDestroy: (a: Record<string, unknown>) => {
        pushEvent({ kind: "documentDestroy", ...a });
      },
    };

    const allTasks: ControlledTask[] = [];
    /** Resolves when a new ControlledTask is created (render() called). */
    let nextTaskWaiter: ((t: ControlledTask) => void) | null = null;
    function waitForNextTask(): Promise<ControlledTask> {
      return new Promise((resolve) => {
        nextTaskWaiter = resolve;
      });
    }
    function makeControlledTask(): ControlledTask {
      const d = deferred<void>();
      const task: ControlledTask = {
        cancelled: false,
        terminal: false,
        cancel: () => {
          if (task.terminal) {
            return;
          }
          task.cancelled = true;
          task.terminal = true;
          d.reject(
            Object.assign(new Error("Rendering cancelled"), {
              name: "RenderingCancelledException",
            })
          );
        },
        promise: d.promise.then(
          () => {
            task.terminal = true;
          },
          (e) => {
            task.terminal = true;
            throw e;
          }
        ),
        settle: () => {
          if (task.terminal) {
            return;
          }
          task.terminal = true;
          d.resolve(undefined);
        },
      };
      allTasks.push(task);
      if (nextTaskWaiter) {
        const w = nextTaskWaiter;
        nextTaskWaiter = null;
        w(task);
      }
      return task;
    }

    const pages = new Map<
      number,
      {
        pageNumber: number;
        cleanup: ReturnType<typeof mock>;
        getViewport: (opts: { scale: number }) => {
          width: number;
          height: number;
          scale: number;
        };
        getTextContent: () => Promise<{ items: unknown[]; styles: object }>;
        getAnnotations: () => Promise<unknown[]>;
        render: () => ControlledTask;
        lastTask: ControlledTask | null;
      }
    >();

    const fakeDoc = {
      numPages: 1,
      destroy: mock(async () => undefined),
      getPage: async (n: number) => {
        let page = pages.get(n);
        if (!page) {
          page = {
            pageNumber: n,
            lastTask: null,
            cleanup: mock(() => undefined),
            getViewport: ({ scale }: { scale: number }) => ({
              width: 100 * scale,
              height: 140 * scale,
              scale,
            }),
            getTextContent: async () => ({ items: [], styles: {} }),
            getAnnotations: async () => [],
            render: () => {
              const task = makeControlledTask();
              page!.lastTask = task;
              return task;
            },
          };
          pages.set(n, page);
        }
        return page;
      },
    };

    type FakeLoadTask = {
      gnoDocId: string;
      deferred: Deferred<typeof fakeDoc>;
      promise: Promise<typeof fakeDoc>;
      destroy: ReturnType<typeof mock>;
      destroyed: boolean;
    };
    let docIdN = 0;
    function fakeGetDocument(
      _params: GnoGetDocumentParams
    ): GnoDocumentLoadingTask {
      const d = deferred<typeof fakeDoc>();
      const task: FakeLoadTask = {
        gnoDocId: `compose-${++docIdN}`,
        deferred: d,
        promise: d.promise,
        destroyed: false,
        destroy: mock(async () => {
          task.destroyed = true;
        }),
      };
      // Resolve on next microtask — progressive mounts after first paint
      queueMicrotask(() => {
        d.resolve(fakeDoc);
      });
      return task as unknown as GnoDocumentLoadingTask;
    }

    type ObserverRecord = {
      callback: IntersectionObserverCallback;
      observed: Set<Element>;
    };
    const observerRegistry: ObserverRecord[] = [];
    class FakeIntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin = "200px 0px";
      readonly thresholds: ReadonlyArray<number> = [0.01];
      private record: ObserverRecord;
      constructor(callback: IntersectionObserverCallback) {
        this.record = { callback, observed: new Set() };
        observerRegistry.push(this.record);
      }
      observe(target: Element): void {
        this.record.observed.add(target);
      }
      unobserve(target: Element): void {
        this.record.observed.delete(target);
      }
      disconnect(): void {
        this.record.observed.clear();
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }

    function emitVisible(pageList: number[]): void {
      for (const rec of observerRegistry) {
        const entries: IntersectionObserverEntry[] = [];
        for (const el of rec.observed) {
          const pageNumber = Number((el as HTMLElement).dataset.pageNumber);
          if (!pageList.includes(pageNumber)) {
            continue;
          }
          entries.push({
            target: el,
            isIntersecting: true,
            intersectionRatio: 1,
            time: Date.now(),
            boundingClientRect: {} as DOMRectReadOnly,
            intersectionRect: {} as DOMRectReadOnly,
            rootBounds: null,
          });
        }
        if (entries.length > 0) {
          rec.callback(entries, {} as IntersectionObserver);
        }
      }
    }

    const computeEffectiveScale = ({
      zoom,
      devicePixelRatio,
      cssWidth,
      cssHeight,
    }: {
      zoom: number;
      devicePixelRatio: number;
      cssWidth: number;
      cssHeight: number;
    }) => {
      const dpr = Math.min(devicePixelRatio, 2);
      return {
        renderScale: zoom * dpr,
        cssScale: zoom,
        canvasWidth: Math.max(1, Math.floor(cssWidth * dpr)),
        canvasHeight: Math.max(1, Math.floor(cssHeight * dpr)),
        dpr,
      };
    };

    const isRenderingCancelled = (err: unknown) =>
      String(err).includes("cancel") ||
      (err as { name?: string })?.name === "RenderingCancelledException";

    const sample = document.createElement("canvas");
    const CanvasCtor = sample.constructor as {
      prototype: HTMLCanvasElement & {
        getContext: (
          this: HTMLCanvasElement,
          ...args: unknown[]
        ) => CanvasRenderingContext2D | null;
      };
    };
    const prevGetContext = CanvasCtor.prototype.getContext.bind(
      CanvasCtor.prototype
    );
    Object.defineProperty(CanvasCtor.prototype, "getContext", {
      configurable: true,
      writable: true,
      value: function getContextStub(this: HTMLCanvasElement) {
        return {
          canvas: this,
          fillRect: () => undefined,
          clearRect: () => undefined,
          scale: () => undefined,
          drawImage: () => undefined,
          setTransform: () => undefined,
          save: () => undefined,
          restore: () => undefined,
        };
      },
    });

    try {
      // Pre-arm start latch before mount so we cannot miss a fast first start
      const firstStartP = waitForMetric(
        events,
        (e) => e.kind === "renderStart"
      );
      const firstTaskP = waitForNextTask();

      renderWithDeps(
        <PdfViewer
          assetUrl="/compose.pdf"
          downloadUrl="/dl.pdf"
          extractedTextAvailable={false}
          onFallback={() => undefined}
        />,
        {
          usePdfDocument: createDocumentHookWithDeps({
            getDocument: fakeGetDocument,
            getPdfMetrics: () =>
              ({
                mintDocId: metrics.mintDocId,
                recordDocumentDestroy: metrics.recordDocumentDestroy,
              }) as never,
          }),
          usePdfPages: createPagesHookWithDeps({
            getPdfMetrics: () => metrics as never,
            computeEffectiveScale: computeEffectiveScale as never,
            isRenderingCancelled,
            IntersectionObserverImpl:
              FakeIntersectionObserver as unknown as typeof IntersectionObserver,
            devicePixelRatio: 1,
          }),
        }
      );

      // Drive progressive + IO: wait for page mount, force container size, emit IO
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(screen.getByTestId("pdf-page-1")).toBeTruthy();
      });

      const column = screen.getByTestId("pdf-page-column");
      Object.defineProperty(column, "clientWidth", {
        configurable: true,
        value: 800,
      });
      Object.defineProperty(column, "clientHeight", {
        configurable: true,
        value: 600,
      });

      await act(async () => {
        emitVisible([1]);
        // Flush slot window + PdfPageView onRender → ensureRendered
        await Promise.resolve();
        await Promise.resolve();
      });

      // Concrete boundary: first renderStart + controlled task in-flight
      const start1 = await firstStartP;
      const task1 = await firstTaskP;
      expect(start1.kind).toBe("renderStart");
      expect(start1.genId).toBeTruthy();
      expect(task1.terminal).toBe(false);
      const genBefore = start1.genId as number;
      const taskId1 = start1.taskId as string;

      // Arm latches for cancel path before zoom
      const cancelP = waitForMetric(
        events,
        (e) => e.kind === "renderCancel" && e.taskId === taskId1
      );
      const cancelledSettleP = waitForMetric(
        events,
        (e) =>
          e.kind === "renderSettle" &&
          e.taskId === taskId1 &&
          e.outcome === "cancelled"
      );
      const start2P = waitForMetric(
        events,
        (e) =>
          e.kind === "renderStart" &&
          (e.genId ?? 0) > genBefore &&
          e.taskId !== taskId1
      );

      // Viewer zoom → genId bump → cancel old → higher-gen replacement
      await act(async () => {
        fireEvent.click(screen.getByTestId("pdf-toolbar-zoom-in"));
        // Allow gen effect + ensureRendered identity change + cancel microtasks
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      const cancelEv = await cancelP;
      const cancelledSettle = await cancelledSettleP;
      const start2 = await start2P;
      await waitFor(() => {
        expect(
          events
            .filter(
              (event) =>
                event.kind === "renderStart" && (event.genId ?? 0) > genBefore
            )
            .map((event) => event.scale)
        ).toContain(1.1);
      });
      const task2 = pages.get(1)?.lastTask;
      expect(task2).toBeDefined();

      expect(cancelEv.genId).toBe(genBefore);
      expect(cancelledSettle.outcome).toBe("cancelled");
      expect(start2.genId as number).toBeGreaterThan(genBefore);

      // Ordering: start1 < cancel < cancelled settle < start2
      expect(start1.seq).toBeLessThan(cancelEv.seq);
      expect(cancelEv.seq).toBeLessThan(cancelledSettle.seq);
      expect(cancelledSettle.seq).toBeLessThan(start2.seq);

      // No completed settle for the cancelled gen-1 task
      expect(
        events.some(
          (e) =>
            e.kind === "renderSettle" &&
            e.taskId === taskId1 &&
            e.outcome === "completed"
        )
      ).toBe(false);

      // Exactly one settle for task1
      expect(
        events.filter((e) => e.kind === "renderSettle" && e.taskId === taskId1)
          .length
      ).toBe(1);

      // Replacement still in-flight (not auto-completed)
      expect(task2?.terminal).toBe(false);
      expect(task2).not.toBe(task1);

      // Settle replacement so teardown cannot hang on open promises
      await act(async () => {
        task2?.settle();
        await Promise.resolve();
        await Promise.resolve();
      });
    } finally {
      // Drain any leftover in-flight controlled tasks
      for (const t of allTasks) {
        if (!t.terminal) {
          try {
            t.settle();
          } catch {
            // ignore
          }
        }
      }
      waiters.length = 0;
      Object.defineProperty(CanvasCtor.prototype, "getContext", {
        configurable: true,
        writable: true,
        value: prevGetContext,
      });
    }
  });
});
