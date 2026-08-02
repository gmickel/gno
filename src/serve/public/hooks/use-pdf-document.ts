import { useCallback, useEffect, useRef, useState } from "react";

import {
  classifyPdfError as defaultClassifyPdfError,
  getDocument as defaultGetDocument,
  getPdfMetrics as defaultGetPdfMetrics,
  type GnoDocumentLoadingTask,
  type PdfFallbackReason,
  type PDFDocumentProxy,
} from "../lib/pdf";

export type PdfDocumentStatus = "loading" | "ready" | "error";

export type UsePdfDocumentResult = {
  status: PdfDocumentStatus;
  doc: PDFDocumentProxy | null;
  numPages: number;
  firstPageReady: boolean;
  error: PdfFallbackReason | null;
  errorMessage: string | null;
  docId: string | null;
  retry: () => void;
};

/**
 * Optional test doubles only. Production call sites pass nothing and use the
 * facade defaults. Not a public product API surface.
 */
export type UsePdfDocumentDeps = {
  getDocument?: typeof defaultGetDocument;
  classifyPdfError?: typeof defaultClassifyPdfError;
  getPdfMetrics?: typeof defaultGetPdfMetrics;
};

type LoadOwnership = {
  /** Minted opaque id for this load attempt. */
  docId: string;
  task: GnoDocumentLoadingTask;
  /** Set only after promise resolves into viewer ownership. */
  viewerDoc: PDFDocumentProxy | null;
  /** True once teardown for this load has run (idempotent). */
  tornDown: boolean;
  /** True once documentDestroy was emitted (success path only). */
  destroyMetricEmitted: boolean;
};

/**
 * Load a PDF document from a same-origin asset URL.
 *
 * Teardown ownership (I3-04): loadingTask.destroy() owns the transport for the
 * entire load lifecycle. documentDestroy is emitted exactly once per
 * successfully loaded viewer instance, never for rejected/never-loaded
 * attempts.
 */
export function usePdfDocument(
  url: string | null,
  deps: UsePdfDocumentDeps = {}
): UsePdfDocumentResult {
  const getDocument = deps.getDocument ?? defaultGetDocument;
  const classifyPdfError = deps.classifyPdfError ?? defaultClassifyPdfError;
  const getPdfMetrics = deps.getPdfMetrics ?? defaultGetPdfMetrics;

  const [status, setStatus] = useState<PdfDocumentStatus>("loading");
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [firstPageReady, setFirstPageReady] = useState(false);
  const [error, setError] = useState<PdfFallbackReason | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const generationRef = useRef(0);
  const ownershipRef = useRef<LoadOwnership | null>(null);

  const retry = useCallback(() => {
    setRetryToken((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!url) {
      setStatus("error");
      setError("network");
      setErrorMessage("No document URL");
      setDoc(null);
      setNumPages(0);
      setFirstPageReady(false);
      setDocId(null);
      return;
    }

    generationRef.current += 1;
    const generation = generationRef.current;
    const metrics = getPdfMetrics();

    setStatus("loading");
    setDoc(null);
    setNumPages(0);
    setFirstPageReady(false);
    setError(null);
    setErrorMessage(null);

    const loadingTask = getDocument({ url });
    const instanceDocId = loadingTask.gnoDocId;
    setDocId(instanceDocId);

    const ownership: LoadOwnership = {
      docId: instanceDocId,
      task: loadingTask,
      viewerDoc: null,
      tornDown: false,
      destroyMetricEmitted: false,
    };
    ownershipRef.current = ownership;

    const isStale = (): boolean => {
      if (generation !== generationRef.current) {
        return true;
      }
      if (ownership.tornDown) {
        return true;
      }
      return Boolean((loadingTask as { destroyed?: boolean }).destroyed);
    };

    /**
     * Idempotent teardown for this load.
     * - Always destroy the loading task exactly once.
     * - Emit documentDestroy only for a viewer-owned success.
     * - A stale late resolution needs no separate proxy cleanup: the loading
     *   task already owns and destroys its transport.
     */
    const teardown = (): void => {
      if (ownership.tornDown) {
        return;
      }
      ownership.tornDown = true;

      const viewerDoc = ownership.viewerDoc;
      ownership.viewerDoc = null;

      if (viewerDoc) {
        if (!ownership.destroyMetricEmitted) {
          ownership.destroyMetricEmitted = true;
          metrics.recordDocumentDestroy({ docId: ownership.docId });
        }
      }

      try {
        void ownership.task.destroy().catch(() => undefined);
      } catch {
        // ignore
      }
    };

    loadingTask.promise
      .then(async (pdf) => {
        if (isStale()) {
          teardown();
          return;
        }
        ownership.viewerDoc = pdf;
        setDoc(pdf);
        setNumPages(pdf.numPages);
        setStatus("ready");
        setFirstPageReady(pdf.numPages > 0);
      })
      .catch((err: unknown) => {
        if (isStale()) {
          return;
        }
        const reason = classifyPdfError(err);
        setStatus("error");
        setError(reason);
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setDoc(null);
        setNumPages(0);
        setFirstPageReady(false);
        teardown();
      });

    return () => {
      if (ownershipRef.current === ownership) {
        ownershipRef.current = null;
      }
      teardown();
    };
  }, [url, retryToken, getDocument, classifyPdfError, getPdfMetrics]);

  return {
    status,
    doc,
    numPages,
    firstPageReady,
    error,
    errorMessage,
    docId,
    retry,
  };
}
