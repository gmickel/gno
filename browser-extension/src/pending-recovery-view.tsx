import type { PendingCapture } from "./types";

interface PendingRecoveryViewProps {
  busy: boolean;
  pending: Omit<PendingCapture, "idempotencyKey">;
  onDiscard: () => void;
  onResume: () => void;
}

export function PendingRecoveryView({
  busy,
  pending,
  onDiscard,
  onResume,
}: PendingRecoveryViewProps) {
  return (
    <section className="panel pending-recovery">
      <strong>Saved write awaiting safe recovery</strong>
      <span>
        {pending.payload.destination.collection}/
        {pending.payload.destination.relPath ??
          pending.payload.destination.folderPath ??
          "automatic path"}
      </span>
      <span>{pending.payload.sourceUrl}</span>
      <p className="hint">
        Retry uses the exact saved payload, preview digest, and idempotency key.
      </p>
      <div className="mode-row">
        <button disabled={busy} onClick={onResume}>
          Retry saved write
        </button>
        <button className="quiet" disabled={busy} onClick={onDiscard}>
          Stop recovery
        </button>
      </div>
    </section>
  );
}
