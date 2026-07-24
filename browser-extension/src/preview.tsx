import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import type {
  BrowserClipPayload,
  BrowserClipPreview,
  CaptureReceipt,
  Destination,
  ExtractionResult,
  PendingCapture,
} from "./types";

import { PairingView } from "./pairing-view";
import { buildBrowserClipPayload } from "./payload";
import { PendingRecoveryView } from "./pending-recovery-view";
import {
  ClipperClientError,
  sendClipperMessage as send,
} from "./runtime-client";
import "./preview.css";

interface ControllerState {
  connected: boolean;
  expiresAt: string | null;
  pending: Omit<PendingCapture, "idempotencyKey"> | null;
  pairing: {
    pairingCode: string;
    expiresAt: string;
  } | null;
}

const defaultDestination: Destination = {
  collection: "",
  relPath: null,
  folderPath: null,
  collisionPolicy: "open_existing",
};

function App() {
  const [controllerState, setControllerState] =
    useState<ControllerState | null>(null);
  const [gatewayOrigin, setGatewayOrigin] = useState("http://127.0.0.1:3000");
  const [mode, setMode] = useState<"selection" | "reader">("selection");
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [destination, setDestination] =
    useState<Destination>(defaultDestination);
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const [editedMarkdown, setEditedMarkdown] = useState<string | null>(null);
  const [preview, setPreview] = useState<BrowserClipPreview | null>(null);
  const [previewStale, setPreviewStale] = useState(true);
  const [receipt, setReceipt] = useState<CaptureReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshState = async () => {
    setControllerState(await send<ControllerState>({ type: "STATE" }));
  };

  useEffect(() => {
    void refreshState().catch((cause) =>
      setError(cause instanceof Error ? cause.message : "Could not load state.")
    );
  }, []);

  useEffect(() => {
    if (!controllerState?.pairing || controllerState.connected) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const result = await send<{ status: string }>({ type: "POLL_PAIR" });
        if (cancelled) return;
        if (result.status === "pending") {
          timeout = setTimeout(() => void poll(), 1500);
          return;
        }
        await refreshState();
        if (result.status !== "approved") {
          setError(
            `[CLIPPER_PAIR_${result.status.toUpperCase()}] Pairing ended. Start again.`
          );
        }
      } catch (cause) {
        if (!cancelled) {
          const message =
            cause instanceof ClipperClientError
              ? `[${cause.code}] ${cause.message}`
              : "Could not poll the local pairing gateway.";
          setError(message);
          timeout = setTimeout(() => void poll(), 2000);
        }
      }
    };
    timeout = setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [controllerState?.connected, controllerState?.pairing]);

  const payload = useMemo<BrowserClipPayload | null>(() => {
    if (!extraction || !destination.collection.trim()) return null;
    try {
      return buildBrowserClipPayload(extraction, {
        mode,
        authenticated,
        destination,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        note: note.trim() || null,
        editedMarkdown,
      });
    } catch {
      return null;
    }
  }, [
    authenticated,
    destination,
    editedMarkdown,
    extraction,
    mode,
    note,
    tags,
  ]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(
        cause instanceof ClipperClientError
          ? `[${cause.code}] ${cause.message}`
          : cause instanceof Error
            ? cause.message
            : "Clipper request failed."
      );
    } finally {
      setBusy(false);
    }
  };

  const invalidate = () => {
    setPreviewStale(true);
    setReceipt(null);
  };

  const startPair = () =>
    run(async () => {
      await send({
        type: "START_PAIR",
        gatewayOrigin,
      });
      await refreshState();
    });

  const pollPair = () =>
    run(async () => {
      const result = await send<{ status: string }>({ type: "POLL_PAIR" });
      if (result.status !== "pending" && result.status !== "approved") {
        throw new Error(`Pairing ended: ${result.status}. Start again.`);
      }
      await refreshState();
    });

  const extract = () =>
    run(async () => {
      const result = await send<ExtractionResult>({ type: "EXTRACT" });
      setExtraction(result);
      setEditedMarkdown(null);
      setPreview(null);
      invalidate();
    });

  const requestPreview = () =>
    run(async () => {
      if (!payload) {
        throw new Error(
          "Extract supported content and choose a destination collection."
        );
      }
      const result = await send<BrowserClipPreview>({
        type: "PREVIEW",
        payload,
      });
      setPreview(result);
      setPreviewStale(false);
      setEditedMarkdown(
        payload.mode === "selection"
          ? payload.selection.editedMarkdown
          : payload.reader.editedMarkdown
      );
      setReceipt(null);
    });

  const capture = () =>
    run(async () => {
      if (!payload || !preview || previewStale) {
        throw new Error("Request a fresh server preview before capturing.");
      }
      const result = await send<{ receipt: CaptureReceipt; replayed: boolean }>(
        {
          type: "CAPTURE",
          payload,
          previewDigest: preview.preview.digest,
        }
      );
      setReceipt(result.receipt);
      await refreshState();
    });

  const revoke = () =>
    run(async () => {
      await send({ type: "REVOKE" });
      setExtraction(null);
      invalidate();
      await refreshState();
    });

  const resumePending = () =>
    run(async () => {
      const result = await send<{
        receipt: CaptureReceipt;
        replayed: boolean;
      }>({ type: "RESUME_PENDING" });
      setReceipt(result.receipt);
      await refreshState();
    });

  const discardPending = () =>
    run(async () => {
      await send({ type: "DISCARD_PENDING" });
      await refreshState();
    });

  if (!controllerState) {
    return <main className="shell">Loading local clipper…</main>;
  }

  if (!controllerState.connected) {
    return (
      <PairingView
        busy={busy}
        error={error}
        gatewayOrigin={gatewayOrigin}
        onGatewayOriginChange={setGatewayOrigin}
        onPoll={() => void pollPair()}
        onStart={() => void startPair()}
        pairing={controllerState.pairing}
      />
    );
  }

  return (
    <main className="shell">
      <header className="compact">
        <div>
          <span className="eyebrow">GNO · CLIPPER</span>
          <h1>Capture visible context</h1>
        </div>
        <button className="quiet" disabled={busy} onClick={() => void revoke()}>
          Revoke
        </button>
      </header>

      <section className="mode-row">
        <button
          className={mode === "selection" ? "active" : "quiet"}
          onClick={() => {
            setMode("selection");
            invalidate();
          }}
        >
          Selection
        </button>
        <button
          className={mode === "reader" ? "active" : "quiet"}
          onClick={() => {
            setMode("reader");
            invalidate();
          }}
        >
          Reader
        </button>
        <button disabled={busy} onClick={() => void extract()}>
          Extract now
        </button>
      </section>

      {extraction ? (
        <section className="panel fields">
          <label>
            Title
            <input
              onChange={(event) => {
                setExtraction({
                  ...extraction,
                  title: event.currentTarget.value,
                });
                invalidate();
              }}
              value={extraction.title}
            />
          </label>
          <label>
            Collection
            <input
              onChange={(event) => {
                setDestination({
                  ...destination,
                  collection: event.currentTarget.value,
                });
                invalidate();
              }}
              placeholder="notes"
              value={destination.collection}
            />
          </label>
          <label>
            Relative path (optional)
            <input
              onChange={(event) => {
                setDestination({
                  ...destination,
                  relPath: event.currentTarget.value || null,
                  folderPath: null,
                });
                invalidate();
              }}
              placeholder="clips/article.md"
              value={destination.relPath ?? ""}
            />
          </label>
          <label>
            Collision policy
            <select
              onChange={(event) => {
                setDestination({
                  ...destination,
                  collisionPolicy: event.currentTarget
                    .value as Destination["collisionPolicy"],
                });
                invalidate();
              }}
              value={destination.collisionPolicy}
            >
              <option value="open_existing">Open identical capture</option>
              <option value="create_with_suffix">Create with suffix</option>
              <option value="error">Stop on collision</option>
            </select>
          </label>
          <label>
            Tags
            <input
              onChange={(event) => {
                setTags(event.currentTarget.value);
                invalidate();
              }}
              placeholder="research, browser"
              value={tags}
            />
          </label>
          <label>
            Note
            <input
              onChange={(event) => {
                setNote(event.currentTarget.value);
                invalidate();
              }}
              value={note}
            />
          </label>
          <label className="check">
            <input
              checked={authenticated}
              onChange={(event) => {
                setAuthenticated(event.currentTarget.checked);
                invalidate();
              }}
              type="checkbox"
            />
            Page contains authenticated visible content
          </label>
        </section>
      ) : null}

      {preview ? (
        <section className="panel preview">
          <div className="outcome">
            {preview.plan.outcome}
            {preview.plan.provenanceConflict ? " · provenance conflict" : ""}
          </div>
          <div className="preview-meta">
            <span>
              {preview.plan.collection}/{preview.plan.relPath}
            </span>
            <code>{preview.preview.digest}</code>
          </div>
          <textarea
            aria-label="Canonical capture Markdown"
            onChange={(event) => {
              setEditedMarkdown(event.currentTarget.value);
              invalidate();
            }}
            rows={12}
            value={editedMarkdown ?? preview.preview.body}
          />
          {previewStale ? (
            <p className="warning">
              Capture changed. Refresh the server preview before confirming.
            </p>
          ) : null}
          <p className="hint">
            Warnings:{" "}
            {(
              preview.provenance.extractionWarnings as string[] | undefined
            )?.join(", ") || "none"}
          </p>
          <details>
            <summary>Server provenance and destination</summary>
            <pre>
              {JSON.stringify(
                {
                  source: preview.preview.source,
                  destination: preview.preview.destination,
                  tags: preview.preview.tags,
                  provenance: preview.provenance,
                  plan: preview.plan,
                },
                null,
                2
              )}
            </pre>
          </details>
        </section>
      ) : null}

      {receipt ? (
        <section className="receipt" role="status">
          <strong>{receipt.collisionPolicyResult}</strong>
          <span>{receipt.uri}</span>
        </section>
      ) : null}

      {controllerState.pending ? (
        <PendingRecoveryView
          busy={busy}
          onDiscard={() => void discardPending()}
          onResume={() => void resumePending()}
          pending={controllerState.pending}
        />
      ) : null}
      {error ? <p className="error">{error}</p> : null}

      <footer>
        <button
          disabled={busy || !payload}
          onClick={() => void requestPreview()}
        >
          {preview ? "Refresh preview" : "Server preview"}
        </button>
        <button
          disabled={busy || !preview || previewStale}
          onClick={() => void capture()}
        >
          Confirm capture
        </button>
      </footer>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Browser clipper root not found");
createRoot(root).render(<App />);
