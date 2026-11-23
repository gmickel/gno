import type React from "react";

import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { PdfPageView } from "../../../../src/serve/public/components/pdf/PdfPageView";
import {
  LIVE_CANVAS_CEILING,
  OVERSCAN_PAGES,
  SCROLL_QUIESCENCE_MS,
  usePdfPages,
} from "../../../../src/serve/public/hooks/use-pdf-pages";

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
  canvasWidth?: number | null;
  canvasHeight?: number | null;
};

const events: MetricEvent[] = [];
let seq = 0;
let taskN = 0;
let capacity = 50_000;
let dropped = 0;
const t0 = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

const metrics = {
  mintDocId: () => "d1",
  mintTaskId: () => {
    taskN += 1;
    return `r${taskN}`;
  },
  bumpGen: () => 1,
  currentGen: () => 1,
  recordRenderStart: (a: Record<string, unknown>) => {
    seq += 1;
    if (events.length >= capacity) {
      events.shift();
      dropped += 1;
    }
    events.push({ seq, t: t0(), kind: "renderStart", ...a } as MetricEvent);
  },
  recordRenderCancel: (a: Record<string, unknown>) => {
    seq += 1;
    if (events.length >= capacity) {
      events.shift();
      dropped += 1;
    }
    events.push({ seq, t: t0(), kind: "renderCancel", ...a } as MetricEvent);
  },
  recordRenderSettle: (a: Record<string, unknown>) => {
    seq += 1;
    if (events.length >= capacity) {
      events.shift();
      dropped += 1;
    }
    events.push({ seq, t: t0(), kind: "renderSettle", ...a } as MetricEvent);
  },
  recordPageCleanup: (a: Record<string, unknown>) => {
    seq += 1;
    if (events.length >= capacity) {
      events.shift();
      dropped += 1;
    }
    events.push({ seq, t: t0(), kind: "pageCleanup", ...a } as MetricEvent);
  },
  recordDocumentDestroy: (a: Record<string, unknown>) => {
    seq += 1;
    if (events.length >= capacity) {
      events.shift();
      dropped += 1;
    }
    events.push({
      seq,
      t: t0(),
      kind: "documentDestroy",
      ...a,
    } as MetricEvent);
  },
  reset: (opts?: { capacity?: number }) => {
    events.length = 0;
    seq = 0;
    taskN = 0;
    dropped = 0;
    if (opts?.capacity != null) {
      capacity = Math.max(1, opts.capacity);
    }
  },
  snapshot: () => ({
    events: events.map((e) => ({ ...e })),
    capacity,
    dropped,
    seqHigh: seq,
    t0Epoch: Date.now(),
  }),
  export: () => metrics.snapshot(),
};

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
    canvasWidth: Math.floor(cssWidth * dpr),
    canvasHeight: Math.floor(cssHeight * dpr),
    dpr,
  };
};

const isRenderingCancelled = (err: unknown) =>
  String(err).includes("cancel") ||
  (err as { name?: string })?.name === "RenderingCancelledException";

// ── Controlled IntersectionObserver ─────────────────────────────────────────

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

/** Emit intersection entries for page numbers against currently observed els. */
function emitIntersections(pageVisibility: Record<number, boolean>): void {
  for (const rec of observerRegistry) {
    const entries: IntersectionObserverEntry[] = [];
    for (const el of rec.observed) {
      const pageNumber = Number((el as HTMLElement).dataset.pageNumber);
      if (!(pageNumber in pageVisibility)) {
        continue;
      }
      entries.push({
        target: el,
        isIntersecting: pageVisibility[pageNumber]!,
        intersectionRatio: pageVisibility[pageNumber] ? 1 : 0,
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

// ── Fake PDF document ───────────────────────────────────────────────────────

type ControlledTask = {
  cancel: () => void;
  promise: Promise<void>;
  settle: () => void;
  fail: (e: unknown) => void;
  cancelled: boolean;
  terminal: boolean;
};

type FakePage = {
  pageNumber: number;
  width: number;
  height: number;
  cleanup: ReturnType<typeof mock>;
  getViewport: (opts: { scale: number }) => {
    width: number;
    height: number;
    scale: number;
  };
  render: (params?: {
    failSync?: boolean;
    canvas?: HTMLCanvasElement;
    canvasContext?: { canvas?: HTMLCanvasElement };
  }) => ControlledTask;
  lastTask: ControlledTask | null;
  failSyncOnRender: boolean;
  nullContext: boolean;
};

const getPageCalls: number[] = [];
const allTasks: ControlledTask[] = [];
/** Real page.render calls, attributed to the exact canvas and minted taskId. */
const renderCalls: Array<{
  pageNumber: number;
  canvas: HTMLCanvasElement | null;
  taskId: string;
  task: ControlledTask;
}> = [];

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
    fail: (e: unknown) => {
      if (task.terminal) {
        return;
      }
      task.terminal = true;
      d.reject(e);
    },
  };
  allTasks.push(task);
  return task;
}

function makeDoc(
  numPages: number,
  opts?: { mixedGeometry?: boolean; failSyncPages?: Set<number> }
) {
  const pages = new Map<number, FakePage>();
  return {
    numPages,
    getPage: async (n: number) => {
      getPageCalls.push(n);
      let page = pages.get(n);
      if (page) {
        return page;
      }
      // Mixed geometry: odd pages portrait, even landscape (different aspect)
      const width = opts?.mixedGeometry && n % 2 === 0 ? 200 : 100;
      const height = opts?.mixedGeometry && n % 2 === 0 ? 100 : 140;
      page = {
        pageNumber: n,
        width,
        height,
        lastTask: null,
        failSyncOnRender: opts?.failSyncPages?.has(n) ?? false,
        nullContext: false,
        cleanup: mock(() => undefined),
        getViewport: ({ scale }: { scale: number }) => ({
          width: width * scale,
          height: height * scale,
          scale,
        }),
        render: (params?: {
          failSync?: boolean;
          canvas?: HTMLCanvasElement;
          canvasContext?: { canvas?: HTMLCanvasElement };
        }) => {
          if (page!.failSyncOnRender) {
            throw new Error("sync render fail");
          }
          const task = makeControlledTask();
          page!.lastTask = task;
          // Attribute this real render call to the exact canvas object the
          // product passed, and to the taskId it minted immediately before
          // (mintTaskId -> page.render with no await between them).
          renderCalls.push({
            pageNumber: n,
            canvas: params?.canvas ?? params?.canvasContext?.canvas ?? null,
            taskId: `r${taskN}`,
            task,
          });
          return task;
        },
      };
      pages.set(n, page);
      return page;
    },
    _pages: pages,
  };
}

/**
 * makeDoc whose `held` pages resolve only when released (or fail when
 * rejected). Page 1 is never held, so geometry publishes from page 1 while the
 * later pages are still pending — the R2 first-paint shape.
 */
function makeHeldDoc(
  numPages: number,
  held: number[],
  opts?: { mixedGeometry?: boolean }
) {
  const base = makeDoc(numPages, opts);
  const gates = new Map<number, Deferred<void>>();
  for (const pageNumber of held) {
    gates.set(pageNumber, deferred<void>());
  }
  return {
    ...base,
    getPage: async (pageNumber: number) => {
      const gate = gates.get(pageNumber);
      if (gate) {
        await gate.promise;
      }
      return base.getPage(pageNumber);
    },
    release: (pageNumber: number) => {
      gates.get(pageNumber)?.resolve(undefined);
    },
    releaseAll: () => {
      for (const gate of gates.values()) {
        gate.resolve(undefined);
      }
    },
    fail: (pageNumber: number, error: unknown) => {
      gates.get(pageNumber)?.reject(error);
    },
  };
}

function stubCanvas2d(opts?: { nullContext?: boolean }): void {
  const sample = document.createElement("canvas");
  // Mounted like PdfPageView does in production: the admission identity
  // requires canvas.isConnected, and a detached canvas is by definition an
  // unmounted page that must not receive a render.
  document.body.appendChild(sample);
  const CanvasCtor = sample.constructor as { prototype: HTMLCanvasElement };
  const fakeCtx = {
    canvas: null as HTMLCanvasElement | null,
    fillRect: () => undefined,
    clearRect: () => undefined,
    scale: () => undefined,
    drawImage: () => undefined,
    setTransform: () => undefined,
    getImageData: () => ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    }),
    putImageData: () => undefined,
    createImageData: () => ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    }),
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    closePath: () => undefined,
    fill: () => undefined,
    stroke: () => undefined,
    translate: () => undefined,
    transform: () => undefined,
    setLineDash: () => undefined,
  };
  Object.defineProperty(CanvasCtor.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: function getContext(this: HTMLCanvasElement, _type: string) {
      if (opts?.nullContext) {
        return null;
      }
      fakeCtx.canvas = this;
      return fakeCtx;
    },
  });
}

function assertOneSettlePerStart(snap: { events: MetricEvent[] }): void {
  const starts = snap.events.filter((e) => e.kind === "renderStart");
  const settles = snap.events.filter((e) => e.kind === "renderSettle");
  for (const id of starts.map((e) => e.taskId)) {
    expect(settles.filter((e) => e.taskId === id).length).toBe(1);
  }
}

const baseDeps = {
  getPdfMetrics: () => metrics as never,
  computeEffectiveScale: computeEffectiveScale as never,
  isRenderingCancelled,
  IntersectionObserverImpl:
    FakeIntersectionObserver as unknown as typeof IntersectionObserver,
};

/** Minimal TextLayer double so the harness never pulls real pdfjs TextLayer. */
class HarnessTextLayer {
  render = async () => undefined;
  update = () => undefined;
  cancel = () => undefined;
  constructor(_opts: unknown) {}
}

/** Full production-like harness: slots + PdfPageView + real observe/render path. */
function VirtualizedViewer(props: {
  doc: ReturnType<typeof makeDoc>;
  docId: string;
  numPages: number;
  genId: number;
  zoom?: number;
}) {
  const pages = usePdfPages({
    doc: props.doc as never,
    docId: props.docId,
    numPages: props.numPages,
    zoom: props.zoom ?? 1,
    fitMode: "custom",
    containerWidth: 800,
    containerHeight: 600,
    genId: props.genId,
    devicePixelRatio: 1,
    ...baseDeps,
  });

  return (
    <div data-testid="viewer">
      <div data-testid="live-count">{pages.liveCanvasCount}</div>
      {pages.slots.map((s) => (
        <PdfPageView
          key={s.pageNumber}
          active={s.active}
          doc={props.doc as never}
          height={s.height}
          onMount={pages.observePage}
          onRender={pages.ensureRendered}
          pageNumber={s.pageNumber}
          rendered={s.rendered}
          scale={pages.scale}
          TextLayerImpl={HarnessTextLayer as never}
          width={s.width}
        />
      ))}
    </div>
  );
}

describe("use-pdf-pages", () => {
  beforeEach(() => {
    metrics.reset({ capacity: 50_000 });
    getPageCalls.length = 0;
    allTasks.length = 0;
    renderCalls.length = 0;
    observerRegistry.length = 0;
    stubCanvas2d();
  });

  afterEach(() => {
    cleanup();
  });

  /** Actual live backing stores: width>0 && height>0 (canvases start zeroed). */
  function countNonzeroBackingCanvases(): number {
    const canvases = [
      ...document.querySelectorAll(".gno-pdf-canvas"),
    ] as HTMLCanvasElement[];
    return canvases.filter((c) => c.width > 0 && c.height > 0).length;
  }

  function captureNonzeroCanvasesInWindow(
    pages: Iterable<number>
  ): HTMLCanvasElement[] {
    const out: HTMLCanvasElement[] = [];
    for (const p of pages) {
      const el = document.querySelector(
        `[data-testid="pdf-page-${p}"] canvas`
      ) as HTMLCanvasElement | null;
      if (el && el.width > 0 && el.height > 0) {
        out.push(el);
      }
    }
    return out;
  }

  async function flushReact(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // Drain ensureRendered macrotasks scheduled after IO/active updates
      await new Promise<void>((r) => setTimeout(r, 0));
      await Promise.resolve();
    });
  }

  async function settleAllTasks(): Promise<void> {
    await act(async () => {
      for (const t of allTasks) {
        if (!t.terminal && !t.cancelled) {
          t.settle();
        }
      }
      await Promise.resolve();
      await Promise.resolve();
      await new Promise<void>((r) => setTimeout(r, 0));
      await Promise.resolve();
    });
    await flushReact();
  }

  async function emitWindow(vis: Record<number, boolean>): Promise<void> {
    await act(async () => {
      emitIntersections(vis);
      await Promise.resolve();
      await Promise.resolve();
      // active→onRender→ensureRendered schedules async work
      await new Promise<void>((r) => setTimeout(r, 0));
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushReact();
  }

  test("I3-01: genuine IO virtualization — actual DOM canvas proof, full prior-window zeroing", async () => {
    const doc = makeDoc(200, { mixedGeometry: true });
    await act(async () => {
      render(
        <VirtualizedViewer doc={doc} docId="d1" genId={1} numPages={200} />
      );
      // Drain page-1 geometry slot effect
      await new Promise<void>((r) => setTimeout(r, 0));
      await Promise.resolve();
    });

    await act(async () => {
      await waitFor(() => {
        expect(
          document.querySelectorAll("[data-testid^=pdf-page-]").length
        ).toBe(200);
      });
    });
    await flushReact();

    // Bounded metadata acquisition resolves every page's rotation-aware
    // placeholder before publishing the scroll model; no page is rendered.
    expect(getPageCalls).toHaveLength(200);
    expect(new Set(getPageCalls).size).toBe(200);
    const geometryOnlyCalls = getPageCalls.length;
    expect(countNonzeroBackingCanvases()).toBe(0);

    // ── Window A: observe near page 50 ──────────────────────────────────
    const windowA = new Set<number>();
    for (let i = 50 - OVERSCAN_PAGES; i <= 50 + OVERSCAN_PAGES; i++) {
      windowA.add(i);
    }

    await emitWindow({ 50: true });

    await act(async () => {
      await waitFor(() => {
        const starts = metrics
          .snapshot()
          .events.filter((e) => e.kind === "renderStart");
        expect(starts.length).toBeGreaterThan(0);
        for (const s of starts) {
          expect(windowA.has(s.pageNumber as number)).toBe(true);
        }
      });
    });

    await settleAllTasks();

    // Actual DOM backing stores (not hook cache): nonzero and <= ceiling
    await act(async () => {
      await waitFor(() => {
        const n = countNonzeroBackingCanvases();
        expect(n).toBeGreaterThan(0);
        expect(n).toBeLessThanOrEqual(LIVE_CANVAS_CEILING);
      });
    });
    const windowALive = countNonzeroBackingCanvases();
    expect(windowALive).toBeGreaterThan(0);
    expect(windowALive).toBeLessThanOrEqual(LIVE_CANVAS_CEILING);

    // Capture EVERY nonzero canvas from prior window for full eviction proof
    const priorWindowCanvases = captureNonzeroCanvasesInWindow(windowA);
    expect(priorWindowCanvases.length).toBeGreaterThan(0);
    expect(priorWindowCanvases.length).toBeLessThanOrEqual(LIVE_CANVAS_CEILING);

    // Metadata covers the document, but actual render calls remain confined to
    // the observed window plus overscan.
    expect(getPageCalls.length).toBeGreaterThanOrEqual(geometryOnlyCalls);
    expect(new Set(renderCalls.map((call) => call.pageNumber))).toEqual(
      windowA
    );

    // ── Window B: disjoint far window at page 150 ───────────────────────
    metrics.reset({ capacity: 50_000 });
    const windowB = new Set<number>();
    for (let i = 150 - OVERSCAN_PAGES; i <= 150 + OVERSCAN_PAGES; i++) {
      windowB.add(i);
    }
    // Disjoint from window A
    for (const p of windowA) {
      expect(windowB.has(p)).toBe(false);
    }

    await emitWindow({ 50: false, 150: true });

    await act(async () => {
      await waitFor(() => {
        const starts = metrics
          .snapshot()
          .events.filter((e) => e.kind === "renderStart");
        expect(starts.length).toBeGreaterThan(0);
        for (const s of starts) {
          expect(windowB.has(s.pageNumber as number)).toBe(true);
        }
      });
    });

    await settleAllTasks();

    // Live DOM canvases still within ceiling and nonzero in new window
    await act(async () => {
      await waitFor(() => {
        const n = countNonzeroBackingCanvases();
        expect(n).toBeGreaterThan(0);
        expect(n).toBeLessThanOrEqual(LIVE_CANVAS_CEILING);
      });
    });

    // EVERY prior-window canvas must be fully zeroed (not merely "some")
    await act(async () => {
      await waitFor(() => {
        expect(priorWindowCanvases.length).toBeGreaterThan(0);
        for (const c of priorWindowCanvases) {
          expect(c.width).toBe(0);
          expect(c.height).toBe(0);
          expect(c.dataset.gnoPdfBacking).not.toBe("1");
        }
      });
    });

    // No starts outside observed+overscan for either window
    const allStarts = metrics
      .snapshot()
      .events.filter((e) => e.kind === "renderStart");
    // (metrics were reset at window B; only B starts here)
    for (const s of allStarts) {
      expect(windowB.has(s.pageNumber as number)).toBe(true);
    }

    // No public setVisiblePages escape hatch on the production result type
    const { result, unmount } = renderHook(() =>
      usePdfPages({
        doc: doc as never,
        docId: "d1",
        numPages: 3,
        zoom: 1,
        fitMode: "custom",
        containerWidth: 800,
        containerHeight: 600,
        genId: 1,
        ...baseDeps,
      })
    );
    await flushReact();
    expect(
      Object.prototype.hasOwnProperty.call(result.current, "setVisiblePages")
    ).toBe(false);
    expect(typeof result.current.disposeAll).toBe("function");
    await act(async () => {
      await result.current.disposeAll();
    });
    unmount();
  });

  test("I3-02: exact cancel→cancelled-settle→replacement-start seq; logical scale; single-owner cancel", async () => {
    const doc = makeDoc(1);
    let genId = 1;
    const { result, rerender } = renderHook(() =>
      usePdfPages({
        doc: doc as never,
        docId: "d1",
        numPages: 1,
        zoom: 1,
        fitMode: "custom",
        containerWidth: 800,
        containerHeight: 600,
        genId,
        devicePixelRatio: 2,
        ...baseDeps,
      })
    );
    await waitFor(() => expect(result.current.slots.length).toBe(1));

    const el = document.createElement("div");
    el.dataset.pageNumber = "1";
    act(() => {
      result.current.observePage(1, el);
    });
    await act(async () => {
      emitIntersections({ 1: true });
    });
    await waitFor(() => expect(result.current.slots[0]?.active).toBe(true));

    metrics.reset({ capacity: 50_000 });
    const canvas = document.createElement("canvas");
    // Mounted like PdfPageView does in production: the admission identity
    // requires canvas.isConnected, and a detached canvas is by definition an
    // unmounted page that must not receive a render.
    document.body.appendChild(canvas);

    // Start gen1 render and leave it in-flight
    let gen1Done: Promise<void> | undefined;
    await act(async () => {
      gen1Done = result.current.ensureRendered(1, canvas);
    });
    await waitFor(() => {
      expect(doc._pages.get(1)?.lastTask).toBeTruthy();
      expect(doc._pages.get(1)?.lastTask?.terminal).toBe(false);
    });
    const task1 = doc._pages.get(1)!.lastTask!;
    const startsAfter1 = metrics
      .snapshot()
      .events.filter((e) => e.kind === "renderStart");
    expect(startsAfter1.length).toBe(1);
    expect(startsAfter1[0]!.scale).toBe(1); // logical, not DPR=2

    // Bump gen; concurrent cancel claims + fire replacement (do not await
    // replacement settle — it stays in-flight until we settle task2).
    genId = 2;
    rerender();
    await act(async () => {
      void result.current.ensureRendered(1, canvas);
      void result.current.ensureRendered(1, canvas);
      // Flush cancel claim microtasks
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(task1.cancelled).toBe(true);
    });
    // gen1 ensureRendered should finish after cancelled settle
    await act(async () => {
      await gen1Done;
    });

    await waitFor(() => {
      expect(
        metrics
          .snapshot()
          .events.some((e) => e.kind === "renderStart" && e.genId === 2)
      ).toBe(true);
    });

    // Settle replacement
    await act(async () => {
      const t2 = doc._pages.get(1)?.lastTask;
      if (t2 && t2 !== task1 && !t2.terminal) {
        t2.settle();
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    const snap = metrics.snapshot();
    const start1 = snap.events.find(
      (e) => e.kind === "renderStart" && e.genId === 1
    );
    const cancel1 = snap.events.find(
      (e) => e.kind === "renderCancel" && start1 && e.taskId === start1.taskId
    );
    const cancelledSettle1 = snap.events.find(
      (e) =>
        e.kind === "renderSettle" &&
        start1 &&
        e.taskId === start1.taskId &&
        e.outcome === "cancelled"
    );
    const start2 = snap.events.find(
      (e) => e.kind === "renderStart" && e.genId === 2
    );
    const terminal2 = snap.events.find(
      (e) =>
        e.kind === "renderSettle" &&
        start2 &&
        e.taskId === start2.taskId &&
        (e.outcome === "completed" || e.outcome === "failed")
    );

    expect(start1).toBeTruthy();
    expect(cancel1).toBeTruthy();
    expect(cancelledSettle1).toBeTruthy();
    expect(start2).toBeTruthy();
    expect(terminal2).toBeTruthy();

    // Exact ordering: start1 < cancel1 < cancelledSettle1 < start2 < terminal2
    expect(start1!.seq).toBeLessThan(cancel1!.seq);
    expect(cancel1!.seq).toBeLessThan(cancelledSettle1!.seq);
    expect(cancelledSettle1!.seq).toBeLessThan(start2!.seq);
    expect(start2!.seq).toBeLessThan(terminal2!.seq);

    expect(
      snap.events.filter(
        (e) => e.kind === "renderCancel" && e.taskId === start1!.taskId
      ).length
    ).toBe(1);
    expect(
      snap.events.some(
        (e) =>
          e.kind === "renderSettle" &&
          e.outcome === "completed" &&
          e.genId === 1
      )
    ).toBe(false);

    expect(start1!.scale).toBe(1);
    expect(start2!.scale).toBe(1);
    expect(start1!.canvasWidth).toBeGreaterThan(0);
    expect(start1!.taskId).not.toBe(start2!.taskId);
    expect(start1!.genId!).toBeLessThan(start2!.genId!);
    assertOneSettlePerStart(snap);

    await act(async () => {
      await result.current.disposeAll();
    });
  });

  test("I3-05: null context / sync render throw rollback; failed promise; disposeAll barrier", async () => {
    // null context
    stubCanvas2d({ nullContext: true });
    const doc = makeDoc(1);
    const { result } = renderHook(() =>
      usePdfPages({
        doc: doc as never,
        docId: "d1",
        numPages: 1,
        zoom: 1,
        fitMode: "custom",
        containerWidth: 800,
        containerHeight: 600,
        genId: 1,
        ...baseDeps,
      })
    );
    await waitFor(() => expect(result.current.slots.length).toBe(1));
    const el = document.createElement("div");
    el.dataset.pageNumber = "1";
    act(() => {
      result.current.observePage(1, el);
    });
    await act(async () => {
      emitIntersections({ 1: true });
    });

    metrics.reset({ capacity: 50_000 });
    const canvas = document.createElement("canvas");
    // Mounted like PdfPageView does in production: the admission identity
    // requires canvas.isConnected, and a detached canvas is by definition an
    // unmounted page that must not receive a render.
    document.body.appendChild(canvas);
    canvas.width = 50;
    canvas.height = 50;
    await act(async () => {
      await result.current.ensureRendered(1, canvas);
    });
    // No start without RenderTask; canvas rolled back
    expect(
      metrics.snapshot().events.filter((e) => e.kind === "renderStart").length
    ).toBe(0);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);

    // sync render throw
    stubCanvas2d();
    const doc2 = makeDoc(1, { failSyncPages: new Set([1]) });
    const h2 = renderHook(() =>
      usePdfPages({
        doc: doc2 as never,
        docId: "d2",
        numPages: 1,
        zoom: 1,
        fitMode: "custom",
        containerWidth: 800,
        containerHeight: 600,
        genId: 1,
        ...baseDeps,
      })
    );
    await waitFor(() => expect(h2.result.current.slots.length).toBe(1));
    const el2 = document.createElement("div");
    el2.dataset.pageNumber = "1";
    act(() => {
      h2.result.current.observePage(1, el2);
    });
    await act(async () => {
      emitIntersections({ 1: true });
    });
    metrics.reset({ capacity: 50_000 });
    const canvas2 = document.createElement("canvas");
    // Mounted like PdfPageView does in production: the admission identity
    // requires canvas.isConnected, and a detached canvas is by definition an
    // unmounted page that must not receive a render.
    document.body.appendChild(canvas2);
    await act(async () => {
      await h2.result.current.ensureRendered(1, canvas2);
    });
    expect(
      metrics.snapshot().events.filter((e) => e.kind === "renderStart").length
    ).toBe(0);
    expect(canvas2.width).toBe(0);

    // failed promise → one failed settle + dispose
    const doc3 = makeDoc(1);
    const h3 = renderHook(() =>
      usePdfPages({
        doc: doc3 as never,
        docId: "d3",
        numPages: 1,
        zoom: 1,
        fitMode: "custom",
        containerWidth: 800,
        containerHeight: 600,
        genId: 1,
        ...baseDeps,
      })
    );
    await waitFor(() => expect(h3.result.current.slots.length).toBe(1));
    const el3 = document.createElement("div");
    el3.dataset.pageNumber = "1";
    act(() => {
      h3.result.current.observePage(1, el3);
    });
    await act(async () => {
      emitIntersections({ 1: true });
    });
    metrics.reset({ capacity: 50_000 });
    const canvas3 = document.createElement("canvas");
    // Mounted like PdfPageView does in production: the admission identity
    // requires canvas.isConnected, and a detached canvas is by definition an
    // unmounted page that must not receive a render.
    document.body.appendChild(canvas3);
    await act(async () => {
      void h3.result.current.ensureRendered(1, canvas3);
    });
    await waitFor(() => expect(doc3._pages.get(1)?.lastTask).toBeTruthy());
    await act(async () => {
      doc3._pages.get(1)!.lastTask!.fail(new Error("boom"));
    });
    await waitFor(() => {
      const fails = metrics
        .snapshot()
        .events.filter(
          (e) => e.kind === "renderSettle" && e.outcome === "failed"
        );
      expect(fails.length).toBe(1);
    });
    assertOneSettlePerStart(metrics.snapshot());
    expect(canvas3.width).toBe(0);

    // disposeAll is awaitable and completes cleanup
    await act(async () => {
      await h3.result.current.disposeAll();
    });
    expect(h3.result.current.liveCanvasCount).toBe(0);
  });

  // ── Deferred render admission (T1–T7) ─────────────────────────────────────

  /** Advance past the quiescence window and drain the resulting flush. */
  async function quiesce(): Promise<void> {
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, SCROLL_QUIESCENCE_MS + 40));
      await Promise.resolve();
      await new Promise<void>((r) => setTimeout(r, 0));
      await Promise.resolve();
    });
    await flushReact();
  }

  const startsOf = () =>
    metrics.snapshot().events.filter((e) => e.kind === "renderStart");
  const startedPages = () =>
    new Set(startsOf().map((e) => e.pageNumber as number));

  async function mount200(genId = 1): Promise<void> {
    const doc = makeDoc(200);
    await act(async () => {
      render(
        <VirtualizedViewer doc={doc} docId="d1" genId={genId} numPages={200} />
      );
      await new Promise<void>((r) => setTimeout(r, 0));
      await Promise.resolve();
    });
    await act(async () => {
      await waitFor(() => {
        expect(
          document.querySelectorAll("[data-testid^=pdf-page-]").length
        ).toBe(200);
      });
    });
    await flushReact();
  }

  test("T2: initial window admits every initially-active page immediately", async () => {
    await mount200();
    // Cold start: the first visible-set mutation is what makes pages active,
    // so the whole initial window must be on the immediate path.
    await emitWindow({ 10: true, 11: true, 12: true });
    const pages = startedPages();
    expect(pages.size).toBeGreaterThan(1);
    for (const p of [10, 11, 12]) {
      expect(pages.has(p)).toBe(true);
    }
  });

  test("T1: 200-page traversal stays far below 60 starts; final window renders after quiescence", async () => {
    await mount200();
    await emitWindow({ 1: true });
    await settleAllTasks();
    const afterInitial = startsOf().length;

    // Continuous traversal: each step enters a new page and leaves the prior.
    // Emitted with microtask yields inside act() so the traversal is genuinely
    // continuous (no 120ms quiescence opens mid-scroll) and fast.
    await act(async () => {
      for (let p = 2; p <= 200; p++) {
        emitIntersections({ [p - 1]: false, [p]: true });
        await Promise.resolve();
      }
    });
    await flushReact();
    const duringScroll = startsOf().length;
    expect(duringScroll).toBeLessThan(60);
    expect(duringScroll - afterInitial).toBeLessThan(60);

    await quiesce();
    await settleAllTasks();
    const total = startsOf().length;
    expect(total).toBeLessThan(60);

    // Exactly the final window renders — multiple pages, not just one.
    const finalWindow = new Set<number>();
    for (let i = 200 - OVERSCAN_PAGES; i <= 200; i++) {
      finalWindow.add(i);
    }
    const rendered = [...startedPages()].filter((p) => finalWindow.has(p));
    expect(rendered.length).toBeGreaterThan(1);
  }, 30_000);

  test("T4: pages entering and leaving before quiescence emit no events", async () => {
    await mount200();
    await emitWindow({ 1: true });
    await settleAllTasks();
    const base = metrics.snapshot().events.length;

    // Enter then leave within one quiescence window. Emitted inside a single
    // act() with microtask yields (matching T1 and T7) so runner scheduling
    // jitter cannot let SCROLL_QUIESCENCE_MS expire mid-sequence.
    await act(async () => {
      emitIntersections({ 40: true });
      await Promise.resolve();
      emitIntersections({ 40: false, 41: true });
      await Promise.resolve();
      emitIntersections({ 41: false, 42: true });
      await Promise.resolve();
      emitIntersections({ 42: false });
      await Promise.resolve();
    });
    await flushReact();

    const transient = metrics
      .snapshot()
      .events.slice(base)
      .filter(
        (e) =>
          (e.kind === "renderStart" ||
            e.kind === "renderCancel" ||
            e.kind === "renderSettle") &&
          [40, 41, 42].includes(e.pageNumber as number)
      );
    expect(transient).toEqual([]);
  });

  test("T7: cadence under the quiescence boundary admits nothing; a pause over it admits", async () => {
    await mount200();
    await emitWindow({ 1: true });
    await settleAllTasks();
    const before = startsOf().length;

    // Sustained cadence strictly under SCROLL_QUIESCENCE_MS. Emitted inside a
    // single act() with only microtask yields so the whole cadence is bounded
    // well below the constant regardless of machine load — the boundary being
    // tested is the hook's, not the harness's.
    await act(async () => {
      for (let p = 60; p < 66; p++) {
        emitIntersections({ [p - 1]: false, [p]: true });
        await Promise.resolve();
      }
    });
    expect(startsOf().length).toBe(before);

    // A pause strictly over the boundary admits.
    await quiesce();
    await settleAllTasks();
    expect(startsOf().length).toBeGreaterThan(before);
  });

  test("T5: disposal during timer expiry starts nothing", async () => {
    const doc = makeDoc(200);
    let api: ReturnType<typeof usePdfPages> | null = null;
    function Probe() {
      api = usePdfPages({
        doc: doc as never,
        docId: "d1",
        genId: 1,
        numPages: 200,
        fitMode: "custom",
        zoom: 1,
        containerWidth: 800,
        containerHeight: 600,
        devicePixelRatio: 1,
        metrics: metrics as never,
        computeEffectiveScale,
        isRenderingCancelled,
        IntersectionObserverImpl:
          FakeIntersectionObserver as unknown as typeof IntersectionObserver,
      } as never);
      return null;
    }
    await act(async () => {
      render(<Probe />);
    });
    await flushReact();
    const before = startsOf().length;
    await act(async () => {
      await api?.disposeAll();
    });
    await quiesce();
    expect(startsOf().length).toBe(before);
  });

  test("T3: a genId commit admits every active page immediately; stale-gen timer no-ops", async () => {
    const doc = makeDoc(200);
    let rerender!: (ui: React.ReactElement) => void;
    await act(async () => {
      const r = render(
        <VirtualizedViewer doc={doc} docId="d1" genId={1} numPages={200} />
      );
      rerender = r.rerender;
      await new Promise<void>((res) => setTimeout(res, 0));
    });
    await act(async () => {
      await waitFor(() => {
        expect(
          document.querySelectorAll("[data-testid^=pdf-page-]").length
        ).toBe(200);
      });
    });
    await flushReact();

    await emitWindow({ 30: true });
    await settleAllTasks();
    // Close the batch and arm a pending timer under generation 1.
    await emitWindow({ 30: false, 31: true });
    await emitWindow({ 31: false, 32: true });
    const beforeCommit = startsOf().length;

    // Generation commit: every currently-active page goes on the immediate path.
    await act(async () => {
      rerender(
        <VirtualizedViewer doc={doc} docId="d1" genId={2} numPages={200} />
      );
      await new Promise<void>((res) => setTimeout(res, 0));
    });
    await flushReact();
    const afterCommit = startsOf().length;
    expect(afterCommit).toBeGreaterThan(beforeCommit);
    const gen2Starts = startsOf().filter((e) => e.genId === 2);
    expect(gen2Starts.length).toBeGreaterThan(1);

    // The timer armed under generation 1 fires afterwards as a no-op: no
    // generation-1 start appears after the commit.
    const countAfter = startsOf().length;
    await quiesce();
    const gen1Late = startsOf()
      .slice(countAfter)
      .filter((e) => e.genId === 1);
    expect(gen1Late).toEqual([]);
  });

  test("T6: deferred flush respects canvas replacement, ceiling and single admission per page", async () => {
    await mount200();
    await emitWindow({ 5: true });
    await settleAllTasks();

    // Close the batch, then defer a distant window.
    await emitWindow({ 5: false, 100: true });
    await emitWindow({ 100: false, 120: true });
    const beforeFlush = startsOf().length;

    await quiesce();
    // Settle to a fixed point: settling one task can admit and start another,
    // so loop until every start has recorded its terminal settle.
    for (let i = 0; i < 12; i++) {
      await settleAllTasks();
      const snapshot = metrics.snapshot();
      const st = snapshot.events.filter((e) => e.kind === "renderStart").length;
      const se = snapshot.events.filter(
        (e) => e.kind === "renderSettle"
      ).length;
      if (st === se) {
        break;
      }
    }

    const after = startsOf();
    // Each admitted page starts at most once per generation.
    const perPage = new Map<number, number>();
    for (const e of after.slice(beforeFlush)) {
      const n = e.pageNumber as number;
      perPage.set(n, (perPage.get(n) ?? 0) + 1);
    }
    for (const count of perPage.values()) {
      expect(count).toBe(1);
    }

    // Ceiling still respected on real DOM backing stores.
    expect(countNonzeroBackingCanvases()).toBeLessThanOrEqual(
      LIVE_CANVAS_CEILING
    );

    // Every start has exactly one terminal settle (no orphans from the gate).
    const snap = metrics.snapshot();
    const starts = snap.events.filter((e) => e.kind === "renderStart");
    const settles = snap.events.filter((e) => e.kind === "renderSettle");
    for (const st of starts) {
      const n = settles.filter((e) => e.taskId === st.taskId).length;
      expect(n).toBe(1);
    }
    expect(snap.dropped).toBe(0);
  });

  test("SOL6-IMPL-02: canvas replaced while getPage is pending starts nothing", async () => {
    // Hold getPage so the canvas can be swapped mid-await, exactly the
    // stale-await window startRenderAdmitted must revalidate.
    const gate = deferred<void>();
    let holdNext = false;
    const base = makeDoc(3);
    const doc = {
      ...base,
      getPage: async (n: number) => {
        // Only the call under test is held; the hook's initial geometry fetch
        // must resolve or no slots are ever created.
        if (holdNext) {
          await gate.promise;
        }
        return base.getPage(n);
      },
    };
    const { result } = renderHook(() =>
      usePdfPages({
        doc: doc as never,
        docId: "d1",
        numPages: 3,
        fitMode: "custom",
        zoom: 1,
        containerWidth: 800,
        containerHeight: 600,
        genId: 1,
        ...baseDeps,
      } as never)
    );
    await waitFor(() => expect(result.current.slots.length).toBe(3));
    const el = document.createElement("div");
    el.dataset.pageNumber = "1";
    act(() => {
      result.current.observePage(1, el);
    });
    await act(async () => {
      emitIntersections({ 1: true });
    });

    metrics.reset({ capacity: 50_000 });
    holdNext = true;
    const canvas = document.createElement("canvas");
    // Sentinel dims: an untouched canvas proves no backing-store allocation
    // (a fresh canvas defaults to 300x150, so 0 would be the wrong oracle).
    canvas.width = 7;
    canvas.height = 11;
    document.body.appendChild(canvas);
    const pending = result.current.ensureRendered(1, canvas);

    // Replace the page's canvas while getPage is still pending. This call is
    // gated too, so it must not be awaited before the gate opens.
    const replacement = document.createElement("canvas");
    document.body.appendChild(replacement);
    const replacing = result.current
      .ensureRendered(1, replacement)
      .catch(() => undefined);

    await act(async () => {
      gate.resolve();
      await Promise.resolve();
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    // Settle BEFORE joining either call: any render task created here (the
    // replacement legitimately, the stale canvas only under a regression)
    // blocks its ensureRendered promise until settled. Joining first would
    // deadlock into a timeout and mask the ownership assertions below.
    await settleAllTasks();
    await pending;
    await replacing;
    await settleAllTasks();

    // Attribute every real page.render call to its exact canvas object.
    // (A width/dimension heuristic cannot do this: renderStart records computed
    // backing dims, never a canvas identity, and the stale sentinel is 7x11.)
    //
    // Identity comparisons below are asserted through small string/boolean
    // projections rather than by handing canvases to the matcher directly:
    // a happy-dom canvas is a deeply linked DOM node, and serializing one into
    // a failure diff exhausts memory (that is what invalidated the first
    // negative-control run with an OOM kill instead of a clean assertion
    // failure). The comparisons themselves are unchanged and still strict.
    const labelOf = (c: unknown): string => {
      if (c === canvas) {
        return "stale";
      }
      if (c === replacement) {
        return "replacement";
      }
      return c == null ? "none" : "other";
    };

    const staleCalls = renderCalls.filter((c) => c.canvas === canvas);
    expect(staleCalls.map((c) => c.taskId)).toEqual([]);

    // The replacement canvas must render normally — otherwise "no stale
    // render" would be trivially satisfied by nothing rendering at all.
    const replacementCalls = renderCalls.filter(
      (c) => c.canvas === replacement
    );
    expect(replacementCalls.length).toBeGreaterThan(0);

    // Positive ownership: EVERY task-bearing metric event must map to a known
    // render call, and that call's canvas must be the replacement. Asserting
    // only "not the stale canvas" would pass on an unmapped taskId or on some
    // third canvas, and deriving stale taskIds from an already-empty staleCalls
    // would make the zero-event claim tautological.
    const taskIdToCanvas = new Map(
      renderCalls.map((c) => [c.taskId, c.canvas])
    );
    const evs = metrics.snapshot().events;
    const taskBearing = evs.filter((e) => e.taskId != null);
    expect(taskBearing.length).toBeGreaterThan(0);
    for (const e of taskBearing) {
      const id = e.taskId as string;
      expect(taskIdToCanvas.has(id)).toBe(true);
      // Diagnostic projection first (names the offending canvas on failure),
      // then the strict object-identity assertion Sol requires.
      expect(labelOf(taskIdToCanvas.get(id))).toBe("replacement");
      expect(taskIdToCanvas.get(id) === replacement).toBe(true);
    }

    // Sentinel dims untouched: no backing-store allocation on the stale canvas.
    expect(canvas.width).toBe(7);
    expect(canvas.height).toBe(11);
  }, 20_000);

  test("SOL6-IMPL-02: canvas disconnected while getPage is pending starts nothing", async () => {
    const gate = deferred<void>();
    let holdNext = false;
    const base = makeDoc(3);
    const doc = {
      ...base,
      getPage: async (n: number) => {
        // Only the call under test is held; the hook's initial geometry fetch
        // must resolve or no slots are ever created.
        if (holdNext) {
          await gate.promise;
        }
        return base.getPage(n);
      },
    };
    const { result } = renderHook(() =>
      usePdfPages({
        doc: doc as never,
        docId: "d1",
        numPages: 3,
        fitMode: "custom",
        zoom: 1,
        containerWidth: 800,
        containerHeight: 600,
        genId: 1,
        ...baseDeps,
      } as never)
    );
    await waitFor(() => expect(result.current.slots.length).toBe(3));
    const el = document.createElement("div");
    el.dataset.pageNumber = "1";
    act(() => {
      result.current.observePage(1, el);
    });
    await act(async () => {
      emitIntersections({ 1: true });
    });

    metrics.reset({ capacity: 50_000 });
    holdNext = true;
    const canvas = document.createElement("canvas");
    // Sentinel dims: an untouched canvas proves no backing-store allocation
    // (a fresh canvas defaults to 300x150, so 0 would be the wrong oracle).
    canvas.width = 7;
    canvas.height = 11;
    document.body.appendChild(canvas);
    const pending = result.current.ensureRendered(1, canvas);

    // Detach it (page unmounted) while getPage is still pending.
    canvas.remove();

    await act(async () => {
      gate.resolve();
      await pending;
      await Promise.resolve();
      await new Promise<void>((r) => setTimeout(r, 0));
    });

    const evs = metrics.snapshot().events;
    expect(evs.filter((e) => e.kind === "renderStart").length).toBe(0);
    expect(evs.length).toBe(0);
    expect(canvas.width).toBe(7);
    expect(canvas.height).toBe(11);
  }, 20_000);

  test("SOL6-IMPL-01: a committed scale change re-renders every active page even when genId is unchanged", async () => {
    // Real-world shape: PdfViewer commits zoom+fitMode+bumpGen together, but
    // React lands the new genId one pass BEFORE the recomputed scale (scale is
    // derived from the ResizeObserver-fed container width). The first pass
    // renders at the NEW genId with the STALE scale; the second pass carries
    // the real scale at the SAME genId. If the scheduler treats
    // "same generation" as "already rendered", the committed zoom is never
    // drawn — the viewer silently keeps the old scale.
    const doc = makeDoc(3);
    let rerender!: (ui: React.ReactElement) => void;
    await act(async () => {
      const r = render(
        <VirtualizedViewer
          doc={doc}
          docId="d1"
          genId={2}
          numPages={3}
          zoom={1}
        />
      );
      rerender = r.rerender;
      await new Promise<void>((res) => setTimeout(res, 0));
    });
    await act(async () => {
      await waitFor(() => {
        expect(
          document.querySelectorAll("[data-testid^=pdf-page-]").length
        ).toBe(3);
      });
    });
    await flushReact();

    await emitWindow({ 1: true, 2: true, 3: true });
    await settleAllTasks();
    const firstScales = startsOf().map((e) => e.scale);
    expect(firstScales.length).toBeGreaterThan(0);
    for (const sc of firstScales) {
      expect(sc).toBe(1);
    }
    const before = startsOf().length;

    // Same genId, new committed scale — exactly the second React pass.
    await act(async () => {
      rerender(
        <VirtualizedViewer
          doc={doc}
          docId="d1"
          genId={2}
          numPages={3}
          zoom={2}
        />
      );
      await new Promise<void>((res) => setTimeout(res, 0));
    });
    await flushReact();
    await settleAllTasks();

    const after = startsOf();
    expect(after.length).toBeGreaterThan(before);
    const atNewScale = after.filter((e) => e.scale === 2);
    // Every active page must be redrawn at the committed scale.
    expect(new Set(atNewScale.map((e) => e.pageNumber)).size).toBe(3);
  }, 20_000);

  test("R2: page 1 geometry publishes every slot and paints before later pages resolve", async () => {
    const doc = makeHeldDoc(3, [2, 3], { mixedGeometry: true });
    await act(async () => {
      render(
        <VirtualizedViewer
          doc={doc as never}
          docId="first-paint"
          genId={1}
          numPages={3}
        />
      );
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    await act(async () => {
      await waitFor(() => {
        expect(
          document.querySelectorAll("[data-testid^=pdf-page-]").length
        ).toBe(3);
      });
    });
    await flushReact();

    // Only page 1 has been measured; the others carry page 1's size.
    expect(getPageCalls).toEqual([1]);
    for (const pageNumber of [1, 2, 3]) {
      const el = document.querySelector(
        `[data-testid="pdf-page-${pageNumber}"]`
      ) as HTMLElement;
      expect(el.style.height).toBe("140px");
    }

    await emitWindow({ 1: true });
    await settleAllTasks();
    expect(
      document
        .querySelector('[data-testid="pdf-page-1"]')
        ?.getAttribute("data-rendered")
    ).toBe("true");
    expect(renderCalls.map((call) => call.pageNumber)).toEqual([1]);

    // Later geometry lands: page 2 (landscape) corrects, page 1 stays drawn
    // at the same scale — no second render of page 1, no unmount. Pages 2 and
    // 3 sit in page 1's overscan window and render once their pages resolve.
    await act(async () => {
      doc.releaseAll();
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    await flushReact();
    await waitFor(() => {
      const page2 = document.querySelector(
        '[data-testid="pdf-page-2"]'
      ) as HTMLElement;
      expect(page2.style.height).toBe("100px");
    });
    expect(
      document
        .querySelector('[data-testid="pdf-page-1"]')
        ?.getAttribute("data-rendered")
    ).toBe("true");
    expect(renderCalls.filter((call) => call.pageNumber === 1)).toHaveLength(1);
    expect(new Set(getPageCalls)).toEqual(new Set([1, 2, 3]));
  });

  test("R2: mixed-size documents settle per-page heights; fit modes recompute against the widest page in one commit", async () => {
    const doc = makeHeldDoc(2, [2], { mixedGeometry: true });
    let fitMode: "width" | "page" = "width";
    let containerWidth = 200;
    let containerHeight = 140;
    const renders: Array<{ scale: number; sizes: number[][] }> = [];
    const { result, rerender } = renderHook(() => {
      const pages = usePdfPages({
        doc: doc as never,
        docId: "mixed",
        numPages: 2,
        zoom: 1,
        fitMode,
        containerWidth,
        containerHeight,
        genId: 1,
        ...baseDeps,
      });
      renders.push({
        scale: pages.scale,
        sizes: pages.slots.map(({ width, height }) => [width, height]),
      });
      return pages;
    });

    // Placeholder publish: fit-width against page 1 alone (200 / 100).
    await waitFor(() => expect(result.current.slots.length).toBe(2));
    expect(result.current.scale).toBe(2);
    expect(
      result.current.slots.map(({ width, height }) => [width, height])
    ).toEqual([
      [200, 280],
      [200, 280],
    ]);
    expect(renderCalls).toHaveLength(0);

    // Full pass: the widest page (200) drives fit-width; sizes correct with it.
    doc.releaseAll();
    await waitFor(() => expect(result.current.scale).toBe(1));
    expect(
      result.current.slots.map(({ width, height }) => [width, height])
    ).toEqual([
      [100, 140],
      [200, 100],
    ]);
    expect(result.current.slots.every((slot) => slot.error === null)).toBe(
      true
    );
    // One commit: no render ever paired the corrected scale with placeholder
    // sizes or the corrected sizes with the placeholder scale.
    for (const snapshot of renders.filter((r) => r.sizes.length === 2)) {
      const corrected =
        snapshot.sizes[1]![0] === 200 && snapshot.sizes[1]![1] === 100;
      expect(snapshot.scale === 1).toBe(corrected);
      expect(snapshot.sizes[0]).toEqual([
        100 * snapshot.scale,
        140 * snapshot.scale,
      ]);
    }
    expect(renderCalls).toHaveLength(0);

    fitMode = "page";
    containerWidth = 150;
    containerHeight = 70;
    rerender();
    await waitFor(() => expect(result.current.scale).toBe(0.5));
    expect(
      result.current.slots.map(({ width, height }) => [width, height])
    ).toEqual([
      [50, 70],
      [100, 50],
    ]);
    expect(renderCalls).toHaveLength(0);
  });

  test("R2: a scale-changing geometry correction opens a new admission epoch", async () => {
    const held = makeHeldDoc(2, [2], { mixedGeometry: true });
    let page2AcquireStarted = 0;
    const originalGetPage = held.getPage.bind(held);
    held.getPage = async (pageNumber: number) => {
      if (pageNumber === 2) {
        page2AcquireStarted += 1;
      }
      return originalGetPage(pageNumber);
    };
    const { result } = renderHook(() =>
      usePdfPages({
        doc: held as never,
        docId: "epoch-correction",
        numPages: 2,
        zoom: 1,
        fitMode: "width",
        containerWidth: 200,
        containerHeight: 140,
        genId: 1,
        ...baseDeps,
      })
    );
    await waitFor(() => expect(result.current.slots.length).toBe(2));
    expect(result.current.scale).toBe(2);

    for (const pageNumber of [1, 2]) {
      const el = document.createElement("div");
      act(() => result.current.observePage(pageNumber, el));
    }
    await act(async () => {
      emitIntersections({ 1: true, 2: true });
    });
    await waitFor(() => expect(result.current.slots[0]?.active).toBe(true));

    const canvas1 = document.createElement("canvas");
    const canvas2 = document.createElement("canvas");
    document.body.appendChild(canvas1);
    document.body.appendChild(canvas2);

    const page1Done = result.current.ensureRendered(1, canvas1);
    await waitFor(() => expect(held._pages.get(1)?.lastTask).toBeTruthy());
    await act(async () => {
      held._pages.get(1)!.lastTask!.settle();
      await page1Done;
    });
    await waitFor(() => expect(result.current.slots[0]?.rendered).toBe(true));
    expect(page2AcquireStarted).toBe(1);

    // Close the exempt batch: a visible-set mutation after an admission.
    await act(async () => {
      emitIntersections({ 2: false });
      emitIntersections({ 2: true });
    });

    await act(async () => {
      void result.current.ensureRendered(2, canvas2);
      await Promise.resolve();
    });
    // Deferred: the held page is not acquired until quiescence. Do not await
    // SCROLL_QUIESCENCE_MS — a second getPage(2) here would mean the batch
    // never closed.
    expect(page2AcquireStarted).toBe(1);
    expect(held._pages.get(2)?.lastTask).toBeUndefined();
    expect(renderCalls.map((call) => call.pageNumber)).toEqual([1]);

    held.releaseAll();
    await waitFor(() => expect(result.current.scale).toBe(1));

    const startsBeforeCorrection = renderCalls.length;
    await act(async () => {
      void result.current.ensureRendered(1, canvas1);
      void result.current.ensureRendered(2, canvas2);
      await Promise.resolve();
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    // New epoch admits immediately: both active pages start without waiting
    // out SCROLL_QUIESCENCE_MS.
    expect(renderCalls.length).toBeGreaterThan(startsBeforeCorrection);
    expect(
      new Set(
        renderCalls.slice(startsBeforeCorrection).map((c) => c.pageNumber)
      )
    ).toEqual(new Set([1, 2]));
  });

  test("R2: the top edge of the page in view stays fixed when later heights land", async () => {
    const doc = makeHeldDoc(4, [2, 3, 4], { mixedGeometry: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { result } = renderHook(() =>
      usePdfPages({
        doc: doc as never,
        docId: "anchor",
        numPages: 4,
        zoom: 1,
        fitMode: "custom",
        containerWidth: 800,
        containerHeight: 600,
        genId: 1,
        scrollContainerRef: { current: container },
        ...baseDeps,
      })
    );
    await waitFor(() => expect(result.current.slots.length).toBe(4));
    expect(result.current.slots.map((slot) => slot.height)).toEqual([
      140, 140, 140, 140,
    ]);

    for (let pageNumber = 1; pageNumber <= 4; pageNumber += 1) {
      const el = document.createElement("div");
      container.appendChild(el);
      act(() => result.current.observePage(pageNumber, el));
    }
    // Page 3 is the page in view; the reader has scrolled to it.
    await act(async () => {
      emitIntersections({ 3: true });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.slots[2]?.visible).toBe(true));
    container.scrollTop = 500;

    doc.releaseAll();
    await waitFor(() =>
      expect(result.current.slots.map((slot) => slot.height)).toEqual([
        140, 100, 140, 100,
      ])
    );
    // Pages above page 3 shrank by 40px in total (page 2: 140 → 100), so the
    // scroll position moved by the same delta and page 3's top edge held.
    expect(container.scrollTop).toBe(460);
  });

  test("R2: the anchor is the page straddling the viewport top, not the first page inside the observer margin", async () => {
    const doc = makeHeldDoc(4, [2, 3, 4], { mixedGeometry: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { result } = renderHook(() =>
      usePdfPages({
        doc: doc as never,
        docId: "layout-anchor",
        numPages: 4,
        zoom: 1,
        fitMode: "custom",
        containerWidth: 800,
        containerHeight: 600,
        genId: 1,
        scrollContainerRef: { current: container },
        ...baseDeps,
      })
    );
    await waitFor(() => expect(result.current.slots.length).toBe(4));
    expect(result.current.slots.map((slot) => slot.height)).toEqual([
      140, 140, 140, 140,
    ]);

    const placeholderHeight = 140;
    const pageGap = 16;
    const pageTop = (pageNumber: number): number =>
      (pageNumber - 1) * (placeholderHeight + pageGap);

    const stubRect = (top: number, height: number): DOMRect =>
      ({
        top,
        left: 0,
        bottom: top + height,
        right: 800,
        width: 800,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;

    container.getBoundingClientRect = () => stubRect(0, 600);
    const elements: HTMLElement[] = [];
    for (let pageNumber = 1; pageNumber <= 4; pageNumber += 1) {
      const el = document.createElement("div");
      container.appendChild(el);
      el.getBoundingClientRect = () =>
        stubRect(pageTop(pageNumber) - container.scrollTop, placeholderHeight);
      act(() => result.current.observePage(pageNumber, el));
      elements.push(el);
    }
    expect(elements).toHaveLength(4);

    // Viewport top sits inside page 3 (offset 312); page 2 (offset 156) is
    // still inside the 200px observer margin. The old visible-set min picks
    // page 2 and applies a 0 delta; layout must pick page 3.
    container.scrollTop = 320;
    await act(async () => {
      emitIntersections({ 2: true, 3: true });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.slots[1]?.visible).toBe(true));
    await waitFor(() => expect(result.current.slots[2]?.visible).toBe(true));

    doc.releaseAll();
    await waitFor(() =>
      expect(result.current.slots.map((slot) => slot.height)).toEqual([
        140, 100, 140, 100,
      ])
    );
    // Pages 1 and 2 sit above the layout anchor (page 3): 0 + (100 - 140) = -40.
    expect(container.scrollTop).toBe(280);
  });

  test("R2: a later page's geometry failure rides on its slot and is not fatal", async () => {
    const doc = makeHeldDoc(3, [2], { mixedGeometry: true });
    const { result } = renderHook(() =>
      usePdfPages({
        doc: doc as never,
        docId: "partial",
        numPages: 3,
        zoom: 1,
        fitMode: "custom",
        containerWidth: 800,
        containerHeight: 600,
        genId: 1,
        ...baseDeps,
      })
    );
    await waitFor(() => expect(result.current.slots.length).toBe(3));

    doc.fail(
      2,
      Object.assign(new Error("corrupted xref"), {
        name: "InvalidPDFException",
      })
    );
    await waitFor(() => expect(result.current.slots[1]?.error).toBe("corrupt"));
    expect(result.current.error).toBeNull();
    expect(result.current.slots).toHaveLength(3);
    expect(result.current.slots.map((slot) => slot.error)).toEqual([
      null,
      "corrupt",
      null,
    ]);
    // The failed slot keeps page 1's placeholder size; page 3 measured normally.
    expect(
      result.current.slots.map(({ width, height }) => [width, height])
    ).toEqual([
      [100, 140],
      [100, 140],
      [100, 140],
    ]);
  });

  test("R2: a render-path getPage failure on a later page is nonfatal and rides on its slot", async () => {
    const doc = makeHeldDoc(3, [2], { mixedGeometry: true });
    const errors: Array<string | null> = [];
    const { result } = renderHook(() => {
      const pages = usePdfPages({
        doc: doc as never,
        docId: "render-partial",
        numPages: 3,
        zoom: 1,
        fitMode: "custom",
        containerWidth: 800,
        containerHeight: 600,
        genId: 1,
        ...baseDeps,
      });
      errors.push(pages.error);
      return pages;
    });
    await waitFor(() => expect(result.current.slots.length).toBe(3));

    for (const pageNumber of [1, 2, 3]) {
      const el = document.createElement("div");
      act(() => result.current.observePage(pageNumber, el));
    }
    await act(async () => {
      emitIntersections({ 1: true, 2: true });
    });

    const canvas1 = document.createElement("canvas");
    document.body.appendChild(canvas1);
    const page1Done = result.current.ensureRendered(1, canvas1);
    await waitFor(() => expect(doc._pages.get(1)?.lastTask).toBeTruthy());
    await act(async () => {
      doc._pages.get(1)!.lastTask!.settle();
      await page1Done;
    });
    await waitFor(() => expect(result.current.slots[0]?.rendered).toBe(true));

    const canvas2 = document.createElement("canvas");
    document.body.appendChild(canvas2);
    let page2Done!: Promise<void>;
    await act(async () => {
      page2Done = result.current.ensureRendered(2, canvas2);
    });
    doc.fail(
      2,
      Object.assign(new Error("corrupted xref"), {
        name: "InvalidPDFException",
      })
    );
    await act(async () => {
      await page2Done;
    });

    await waitFor(() => {
      expect(result.current.slots[1]?.error).toBe("corrupt");
      expect(result.current.error).toBeNull();
      expect(result.current.slots).toHaveLength(3);
      expect(result.current.slots[0]?.rendered).toBe(true);
    });
    // The render path must never publish a fatal hook error: a transient
    // `error === "corrupt"` fires the viewer's text fallback even if a later
    // correction commit clears it.
    expect(errors).not.toContain("corrupt");
  });

  test("page metadata acquisition failures surface a classified viewer error", async () => {
    const doc = {
      numPages: 1,
      getPage: async () => {
        throw Object.assign(new Error("Password required"), {
          name: "PasswordException",
        });
      },
    };
    const { result } = renderHook(() =>
      usePdfPages({
        doc: doc as never,
        docId: "protected",
        numPages: 1,
        zoom: 1,
        fitMode: "custom",
        containerWidth: 800,
        containerHeight: 600,
        genId: 1,
        ...baseDeps,
      })
    );
    await waitFor(() => expect(result.current.error).toBe("password"));
    expect(result.current.slots).toHaveLength(0);
  });

  test("render-setup exceptions release admission so retry can render", async () => {
    stubCanvas2d();
    const doc = makeDoc(1);
    const { result } = renderHook(() =>
      usePdfPages({
        doc: doc as never,
        docId: "setup-retry",
        numPages: 1,
        zoom: 1,
        fitMode: "custom",
        containerWidth: 800,
        containerHeight: 600,
        genId: 1,
        ...baseDeps,
      })
    );
    await waitFor(() => expect(result.current.slots).toHaveLength(1));
    const page = doc._pages.get(1);
    if (!page) {
      throw new Error("expected page geometry to be cached");
    }
    const realGetViewport = page.getViewport;
    let failSetup = true;
    page.getViewport = (params) => {
      if (failSetup) {
        throw new Error("viewport setup failed");
      }
      return realGetViewport(params);
    };

    const element = document.createElement("div");
    const canvas = document.createElement("canvas");
    document.body.append(element, canvas);
    act(() => result.current.observePage(1, element));
    await act(async () => emitIntersections({ 1: true }));

    await act(async () => result.current.ensureRendered(1, canvas));
    expect(result.current.error).toBe("corrupt");
    expect(canvas.width).toBe(0);
    expect(result.current.liveCanvasCount).toBe(0);

    failSetup = false;
    const retryPromise = result.current.ensureRendered(1, canvas);
    await waitFor(() => expect(result.current.error).toBeNull());
    await waitFor(() => expect(result.current.liveCanvasCount).toBe(1));
    expect(
      metrics.snapshot().events.filter((event) => event.kind === "renderStart")
    ).toHaveLength(1);

    await settleAllTasks();
    await retryPromise;
  });

  test("concurrent cold-window admissions reserve the live-canvas ceiling atomically", async () => {
    const doc = makeDoc(14);
    const { result } = renderHook(() =>
      usePdfPages({
        doc: doc as never,
        docId: "ceiling",
        numPages: 14,
        zoom: 1,
        fitMode: "custom",
        containerWidth: 800,
        containerHeight: 600,
        genId: 1,
        ...baseDeps,
      })
    );
    await waitFor(() => expect(result.current.slots.length).toBe(14));

    for (let pageNumber = 1; pageNumber <= 12; pageNumber += 1) {
      const element = document.createElement("div");
      act(() => result.current.observePage(pageNumber, element));
    }
    await act(async () => {
      emitIntersections(
        Object.fromEntries(
          Array.from({ length: 12 }, (_, index) => [index + 1, true])
        )
      );
      await Promise.resolve();
    });

    const pending: Promise<void>[] = [];
    for (let pageNumber = 1; pageNumber <= 12; pageNumber += 1) {
      const canvas = document.createElement("canvas");
      document.body.appendChild(canvas);
      pending.push(result.current.ensureRendered(pageNumber, canvas));
    }
    await waitFor(() =>
      expect(
        metrics
          .snapshot()
          .events.filter((event) => event.kind === "renderStart").length
      ).toBe(LIVE_CANVAS_CEILING)
    );
    expect(countNonzeroBackingCanvases()).toBeLessThanOrEqual(
      LIVE_CANVAS_CEILING
    );
    expect(result.current.liveCanvasCount).toBeLessThanOrEqual(
      LIVE_CANVAS_CEILING
    );

    await settleAllTasks();
    await Promise.all(pending);
  });

  test("same-generation scale replacement owns a pending getPage continuation", async () => {
    const gate = deferred<void>();
    let holdNext = false;
    const base = makeDoc(1);
    const doc = {
      ...base,
      getPage: async (pageNumber: number) => {
        if (holdNext) {
          holdNext = false;
          await gate.promise;
        }
        return base.getPage(pageNumber);
      },
    };
    let zoom = 1;
    const { result, rerender } = renderHook(() =>
      usePdfPages({
        doc: doc as never,
        docId: "scale-race",
        numPages: 1,
        zoom,
        fitMode: "custom",
        containerWidth: 800,
        containerHeight: 600,
        genId: 1,
        ...baseDeps,
      })
    );
    await waitFor(() => expect(result.current.slots.length).toBe(1));
    const element = document.createElement("div");
    act(() => result.current.observePage(1, element));
    await act(async () => {
      emitIntersections({ 1: true });
      await Promise.resolve();
    });

    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    holdNext = true;
    const stale = result.current.ensureRendered(1, canvas);

    zoom = 2;
    rerender();
    await waitFor(() => expect(result.current.scale).toBe(2));
    const replacement = result.current.ensureRendered(1, canvas);
    await waitFor(() =>
      expect(
        metrics
          .snapshot()
          .events.filter((event) => event.kind === "renderStart")
      ).toHaveLength(1)
    );
    expect(
      metrics.snapshot().events.find((event) => event.kind === "renderStart")
        ?.scale
    ).toBe(2);

    await act(async () => {
      gate.resolve();
      await stale;
    });
    expect(
      metrics.snapshot().events.filter((event) => event.kind === "renderStart")
    ).toHaveLength(1);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(280);

    await settleAllTasks();
    await replacement;
  });

  test("retention through hook churn + disposeAll; metrics survive unmount", async () => {
    const doc = makeDoc(5);
    let genId = 1;
    const { result, rerender, unmount } = renderHook(() =>
      usePdfPages({
        doc: doc as never,
        docId: "d1",
        numPages: 5,
        zoom: 1,
        fitMode: "custom",
        containerWidth: 800,
        containerHeight: 600,
        genId,
        ...baseDeps,
      })
    );
    await waitFor(() => expect(result.current.slots.length).toBe(5));

    for (let p = 1; p <= 5; p++) {
      const el = document.createElement("div");
      el.dataset.pageNumber = String(p);
      act(() => {
        result.current.observePage(p, el);
      });
    }
    await act(async () => {
      emitIntersections({ 1: true, 2: true, 3: true });
    });
    await waitFor(() =>
      expect(result.current.slots.some((s) => s.active)).toBe(true)
    );

    metrics.reset({ capacity: 5 });
    for (let round = 0; round < 20; round++) {
      genId = round + 1;
      rerender();
      const page = (round % 3) + 1;
      const canvas = document.createElement("canvas");
      // Mounted like PdfPageView does in production: the admission identity
      // requires canvas.isConnected, and a detached canvas is by definition an
      // unmounted page that must not receive a render.
      document.body.appendChild(canvas);
      await act(async () => {
        emitIntersections({ 1: true, 2: true, 3: true });
        void result.current.ensureRendered(page, canvas);
      });
      await act(async () => {
        for (const t of allTasks) {
          if (!t.terminal && !t.cancelled) {
            t.settle();
          }
        }
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    const mid = metrics.snapshot();
    expect(mid.dropped).toBeGreaterThan(0);
    expect(mid.events.length).toBeLessThanOrEqual(5);

    metrics.reset({ capacity: 500 });
    expect(metrics.snapshot().dropped).toBe(0);
    await act(async () => {
      await result.current.disposeAll();
    });
    unmount();
    expect(metrics.snapshot().dropped).toBe(0);
  });
});
