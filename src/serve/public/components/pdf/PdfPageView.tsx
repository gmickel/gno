import { useEffect, useRef } from "react";

import {
  sanitizeAnnotationUrl as defaultSanitizeAnnotationUrl,
  TextLayer as DefaultTextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type PdfAnnotation,
  type PageViewport,
} from "../../lib/pdf";

export type PdfPageViewProps = {
  doc: PDFDocumentProxy | null;
  pageNumber: number;
  width: number;
  height: number;
  scale: number;
  rendered: boolean;
  onMount: (pageNumber: number, el: HTMLElement | null) => void;
  onRender: (pageNumber: number, canvas: HTMLCanvasElement | null) => void;
  onInternalNavigate?: (pageNumber: number) => void;
  active: boolean;
  /** Optional test doubles only — production uses facade defaults. */
  TextLayerImpl?: typeof DefaultTextLayer;
  sanitizeAnnotationUrl?: typeof defaultSanitizeAnnotationUrl;
};

/** Exact pdfjs v5 scale CSS contract (wrapper + layers). */
export function applyScaleCssVars(
  el: HTMLElement,
  viewportScale: number
): void {
  el.style.setProperty("--scale-factor", String(viewportScale));
  el.style.setProperty(
    "--total-scale-factor",
    "calc(var(--scale-factor) * var(--user-unit, 1))"
  );
  el.style.setProperty("--scale-round-x", "1px");
  el.style.setProperty("--scale-round-y", "1px");
}

function applyTextLayerBox(el: HTMLElement, viewport: PageViewport): void {
  applyScaleCssVars(el, viewport.scale);
  el.style.width = `${viewport.width}px`;
  el.style.height = `${viewport.height}px`;
}

/**
 * Apply the current viewport scale contract to the page wrapper and layers.
 * Wrapper receives the CSS vars only (slot width/height stay from props).
 */
function applyViewportScaleContract(
  root: HTMLElement | null,
  textContainer: HTMLElement | null,
  inner: HTMLElement | null,
  viewport: PageViewport
): void {
  if (root) {
    applyScaleCssVars(root, viewport.scale);
  }
  if (textContainer) {
    applyTextLayerBox(textContainer, viewport);
  }
  if (inner) {
    applyTextLayerBox(inner, viewport);
  }
}

/**
 * One page: rotation-aware placeholder, canvas, retained TextLayer (v5
 * render / update / cancel), safe links.
 */
export function PdfPageView({
  doc,
  pageNumber,
  width,
  height,
  scale,
  rendered,
  onMount,
  onRender,
  onInternalNavigate,
  active,
  TextLayerImpl = DefaultTextLayer,
  sanitizeAnnotationUrl = defaultSanitizeAnnotationUrl,
}: PdfPageViewProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const linkLayerRef = useRef<HTMLDivElement | null>(null);
  const textLayerInstanceRef = useRef<InstanceType<
    typeof DefaultTextLayer
  > | null>(null);
  /** Bumped on page/doc/active identity changes (rebuild path). */
  const layerBuildGenRef = useRef(0);
  const annotGenRef = useRef(0);
  const pageProxyRef = useRef<PDFPageProxy | null>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const onInternalNavigateRef = useRef(onInternalNavigate);
  onInternalNavigateRef.current = onInternalNavigate;

  useEffect(() => {
    onMount(pageNumber, rootRef.current);
    return () => {
      onMount(pageNumber, null);
    };
  }, [pageNumber, onMount]);

  // Start with zero backing store so default 300×150 never masquerades as live.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas && canvas.dataset.gnoPdfBacking !== "1") {
      canvas.width = 0;
      canvas.height = 0;
    }
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }
    onRender(pageNumber, canvasRef.current);
  }, [active, pageNumber, onRender, scale]);

  // Build TextLayer once per page/doc/container identity (I3-03).
  useEffect(() => {
    const textContainer = textLayerRef.current;
    const inner = innerRef.current;
    const root = rootRef.current;
    if (!doc || !active || !textContainer) {
      return;
    }

    layerBuildGenRef.current += 1;
    const buildGen = layerBuildGenRef.current;
    let cancelled = false;
    const isStale = () => cancelled || buildGen !== layerBuildGenRef.current;

    void (async () => {
      let page: PDFPageProxy;
      try {
        page = await doc.getPage(pageNumber);
      } catch {
        return;
      }
      if (isStale()) {
        return;
      }
      pageProxyRef.current = page;

      let textContent: Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;
      try {
        textContent = await page.getTextContent();
      } catch {
        return;
      }
      // Guard immediately before any DOM mutation (stale after every await).
      if (isStale()) {
        return;
      }

      // Cancel any prior retained layer before replace.
      textLayerInstanceRef.current?.cancel();
      textLayerInstanceRef.current = null;
      if (isStale()) {
        return;
      }
      textContainer.replaceChildren();

      const logicalScale = scaleRef.current;
      const viewport = page.getViewport({
        scale: logicalScale,
      }) as PageViewport;
      if (isStale()) {
        return;
      }
      applyViewportScaleContract(root, textContainer, inner, viewport);

      try {
        if (isStale()) {
          return;
        }
        const layer = new TextLayerImpl({
          textContentSource: textContent,
          container: textContainer,
          viewport,
        });
        if (isStale()) {
          layer.cancel();
          return;
        }
        textLayerInstanceRef.current = layer;
        await layer.render();
        if (isStale()) {
          layer.cancel();
          if (textLayerInstanceRef.current === layer) {
            textLayerInstanceRef.current = null;
          }
          return;
        }
        // If scale changed during build, apply retained update with latest scale.
        if (scaleRef.current !== logicalScale) {
          if (isStale()) {
            return;
          }
          const latest = page.getViewport({
            scale: scaleRef.current,
          }) as PageViewport;
          applyViewportScaleContract(root, textContainer, inner, latest);
          try {
            layer.update({ viewport: latest });
          } catch {
            // ignore
          }
        }
      } catch {
        // empty text layer ok
      }
    })();

    return () => {
      cancelled = true;
      // Identity teardown: cancel retained layer.
      if (buildGen === layerBuildGenRef.current) {
        textLayerInstanceRef.current?.cancel();
        textLayerInstanceRef.current = null;
        pageProxyRef.current = null;
      }
    };
    // scale intentionally excluded — zoom uses update path below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scale via update effect
  }, [doc, pageNumber, active, TextLayerImpl]);

  // Viewport zoom/rotation: retained TextLayer.update + wrapper scale (I3-03/06).
  useEffect(() => {
    const textContainer = textLayerRef.current;
    const inner = innerRef.current;
    const root = rootRef.current;
    const layer = textLayerInstanceRef.current;
    const page = pageProxyRef.current;
    if (!doc || !active || !textContainer || !layer || !page) {
      return;
    }

    const viewport = page.getViewport({ scale }) as PageViewport;
    applyViewportScaleContract(root, textContainer, inner, viewport);
    try {
      layer.update({ viewport });
    } catch {
      // If update fails, leave layer as-is; next identity rebuild will replace.
    }
  }, [doc, active, scale]);

  // Link annotations with stale guards after every await.
  useEffect(() => {
    const linkContainer = linkLayerRef.current;
    if (!doc || !active || !linkContainer) {
      return;
    }

    annotGenRef.current += 1;
    const gen = annotGenRef.current;
    let cancelled = false;
    const isStale = () => cancelled || gen !== annotGenRef.current;

    void (async () => {
      let page: PDFPageProxy;
      try {
        page = await doc.getPage(pageNumber);
      } catch {
        return;
      }
      if (isStale()) {
        return;
      }
      const viewport = page.getViewport({ scale }) as PageViewport;
      // Guard again immediately before DOM writes.
      if (isStale()) {
        return;
      }
      linkContainer.replaceChildren();
      linkContainer.style.width = `${viewport.width}px`;
      linkContainer.style.height = `${viewport.height}px`;

      let annots: PdfAnnotation[];
      try {
        annots = (await page.getAnnotations({
          intent: "display",
        })) as PdfAnnotation[];
      } catch {
        return;
      }
      if (isStale()) {
        return;
      }

      for (const annot of annots) {
        if ((annot.subtype ?? "").toLowerCase() !== "link") {
          continue;
        }
        const rect = annot.rect;
        if (!rect || rect.length < 4) {
          continue;
        }
        const [x1, y1] = viewport.convertToViewportPoint(rect[0]!, rect[1]!);
        const [x2, y2] = viewport.convertToViewportPoint(rect[2]!, rect[3]!);
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const w = Math.abs(x1 - x2);
        const h = Math.abs(y1 - y2);

        const rawUrl = annot.url ?? annot.unsafeUrl;
        if (rawUrl) {
          const safe = sanitizeAnnotationUrl(rawUrl);
          if (safe) {
            const anchor = document.createElement("a");
            anchor.className = "gno-pdf-annotation-link";
            anchor.style.left = `${left}px`;
            anchor.style.top = `${top}px`;
            anchor.style.width = `${w}px`;
            anchor.style.height = `${h}px`;
            anchor.href = safe;
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
            anchor.setAttribute("data-annotation", "external");
            if (!isStale()) {
              linkContainer.appendChild(anchor);
            }
          } else {
            const span = document.createElement("span");
            span.className = "gno-pdf-annotation-inert";
            span.style.left = `${left}px`;
            span.style.top = `${top}px`;
            span.style.width = `${w}px`;
            span.style.height = `${h}px`;
            span.setAttribute("data-annotation", "inert");
            span.setAttribute("aria-hidden", "true");
            if (!isStale()) {
              linkContainer.appendChild(span);
            }
          }
          continue;
        }

        if (annot.dest) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "gno-pdf-annotation-link";
          btn.style.left = `${left}px`;
          btn.style.top = `${top}px`;
          btn.style.width = `${w}px`;
          btn.style.height = `${h}px`;
          btn.setAttribute("data-annotation", "internal");
          const destSnapshot = annot.dest;
          // Capture generation for post-await destination/index resolution.
          const clickGen = gen;
          btn.addEventListener("click", (ev) => {
            ev.preventDefault();
            void (async () => {
              try {
                if (cancelled || clickGen !== annotGenRef.current) {
                  return;
                }
                const dest =
                  typeof destSnapshot === "string"
                    ? await doc.getDestination(destSnapshot)
                    : destSnapshot;
                if (cancelled || clickGen !== annotGenRef.current) {
                  return;
                }
                if (!Array.isArray(dest) || !dest[0]) {
                  return;
                }
                const idx = await doc.getPageIndex(dest[0] as never);
                if (cancelled || clickGen !== annotGenRef.current) {
                  return;
                }
                onInternalNavigateRef.current?.(idx + 1);
              } catch {
                // ignore
              }
            })();
          });
          if (!isStale()) {
            linkContainer.appendChild(btn);
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, scale, active, sanitizeAnnotationUrl]);

  useEffect(() => {
    if (active) {
      return;
    }
    textLayerInstanceRef.current?.cancel();
    textLayerInstanceRef.current = null;
    pageProxyRef.current = null;
    linkLayerRef.current?.replaceChildren();
  }, [active]);

  return (
    <div
      ref={rootRef}
      className="gno-pdf-page"
      data-page-number={pageNumber}
      data-rendered={rendered ? "true" : "false"}
      data-testid={`pdf-page-${pageNumber}`}
      style={{
        width: width || undefined,
        height: height || undefined,
        aspectRatio: width && height ? `${width} / ${height}` : undefined,
      }}
    >
      <div ref={innerRef} className="gno-pdf-page-inner">
        <canvas ref={canvasRef} className="gno-pdf-canvas" />
        <div ref={textLayerRef} className="textLayer gno-pdf-text-layer" />
        <div ref={linkLayerRef} className="gno-pdf-annotation-layer" />
      </div>
    </div>
  );
}
