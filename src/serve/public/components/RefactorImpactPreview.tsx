/**
 * Canonical refactor impact preview for rename/move dialogs.
 * Scholarly Dusk vocabulary: rail-style labels, mono paths, amber caution.
 *
 * @module src/serve/public/components/RefactorImpactPreview
 */

import type { FileRefactorPreviewPlan } from "../../../core/file-refactor-contract";

const UNRESOLVED_CLASSIFICATIONS = new Set([
  "ambiguous",
  "unsupported",
  "malformed",
  "invalid",
]);

function shortDigest(digest: string): string {
  return `${digest.slice(0, 8)}…${digest.slice(-6)}`;
}

export interface RefactorImpactPreviewProps {
  plan: FileRefactorPreviewPlan | null;
  loading?: boolean;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  /** Accessible outcome message after apply (sync-pending, recovery, etc.). */
  outcomeMessage?: string | null;
  outcomeTone?: "warning" | "error" | "success";
}

export function RefactorImpactPreview({
  plan,
  loading = false,
  confirmed,
  onConfirmedChange,
  outcomeMessage,
  outcomeTone = "warning",
}: RefactorImpactPreviewProps) {
  if (loading && !plan) {
    return (
      <div
        aria-busy="true"
        aria-live="polite"
        className="rounded-md border border-border/30 bg-muted/20 px-3 py-2 font-mono text-[11px] text-muted-foreground"
      >
        Computing reference impact…
      </div>
    );
  }

  if (!plan) {
    return null;
  }

  const rewriteable = plan.examinedReferences.filter(
    (ref) => ref.classification === "rewriteable"
  );
  const unresolved = plan.examinedReferences.filter((ref) =>
    UNRESOLVED_CLASSIFICATIONS.has(ref.classification)
  );
  const affectedPaths = plan.affectedDocuments.map((doc) => doc.relPath);
  const confirmId = `refactor-confirm-${plan.planDigest.slice(0, 12)}`;

  const outcomeClass =
    outcomeTone === "error"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : outcomeTone === "success"
        ? "border-primary/30 bg-primary/10 text-primary"
        : "border-amber-500/30 bg-amber-500/10 text-amber-500";

  return (
    <div className="max-h-[40vh] space-y-3 overflow-y-auto pr-1">
      <div className="space-y-1">
        <div className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-[0.15em]">
          Safety
        </div>
        <div
          aria-live="polite"
          className={
            plan.canApply
              ? "rounded-md border border-primary/25 bg-primary/10 px-3 py-2 text-[13px] text-primary"
              : "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
          }
          role="status"
        >
          {plan.canApply
            ? "Plan is safe to apply with the exact digest below."
            : `Cannot apply: ${(plan.safety.blockingReasonCodes[0] ?? "blocked").replaceAll("_", " ")}.`}
        </div>
        <p className="font-mono text-[11px] text-muted-foreground/70 break-all">
          Digest {shortDigest(plan.planDigest)}
        </p>
      </div>

      <div className="space-y-1">
        <div className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-[0.15em]">
          Target
        </div>
        <p className="font-mono text-[11px] text-muted-foreground/80 break-all">
          {plan.source.relPath} → {plan.target.relPath}
        </p>
        <p className="font-mono text-[10px] text-muted-foreground/50 tabular-nums">
          {plan.safety.rewriteableCount} rewrite
          {plan.safety.rewriteableCount === 1 ? "" : "s"} ·{" "}
          {plan.safety.unchangedCount} unchanged · {unresolved.length}{" "}
          unresolved
        </p>
      </div>

      {affectedPaths.length > 0 && (
        <div className="space-y-1">
          <div className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-[0.15em]">
            Affected documents
          </div>
          <ul className="space-y-0.5">
            {affectedPaths.map((path) => (
              <li
                className="font-mono text-[11px] text-muted-foreground/80 break-all"
                key={path}
              >
                {path}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rewriteable.length > 0 && (
        <div className="space-y-1">
          <div className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-[0.15em]">
            Rewrites
          </div>
          <ul className="space-y-1">
            {rewriteable.slice(0, 12).map((ref) => (
              <li
                className="rounded-sm px-2 py-1 font-mono text-[11px] text-muted-foreground hover:bg-muted/20"
                key={`${ref.documentRelPath}:${ref.startLine ?? 0}:${ref.startCol ?? 0}:${ref.originalDestination ?? ""}`}
              >
                <span className="text-foreground/90">
                  {ref.documentRelPath}
                </span>
                <span className="text-muted-foreground/50"> · </span>
                <span>
                  {ref.originalDestination ?? "?"} →{" "}
                  {ref.proposedDestination ?? "?"}
                </span>
              </li>
            ))}
            {rewriteable.length > 12 && (
              <li className="font-mono text-[10px] text-muted-foreground/50">
                +{rewriteable.length - 12} more
              </li>
            )}
          </ul>
        </div>
      )}

      {unresolved.length > 0 && (
        <div className="space-y-1">
          <div className="font-mono text-[10px] text-amber-500/70 uppercase tracking-[0.15em]">
            Unresolved / unsupported
          </div>
          <ul className="space-y-1">
            {unresolved.slice(0, 12).map((ref) => (
              <li
                className="rounded-sm border border-amber-500/20 bg-amber-500/5 px-2 py-1 font-mono text-[11px] text-amber-500/90"
                key={`${ref.documentRelPath}:${ref.classification}:${ref.startLine ?? 0}:${ref.originalDestination ?? ""}`}
              >
                <span>
                  {ref.documentRelPath}
                  {ref.startLine ? `:${ref.startLine}` : ""}
                </span>
                <span className="opacity-60"> · {ref.classification}</span>
                {ref.reasonCode && (
                  <span className="opacity-60"> · {ref.reasonCode}</span>
                )}
              </li>
            ))}
            {unresolved.length > 12 && (
              <li className="font-mono text-[10px] text-amber-500/60">
                +{unresolved.length - 12} more
              </li>
            )}
          </ul>
        </div>
      )}

      {plan.safety.warnings.length > 0 && (
        <div
          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-500 text-sm"
          role="status"
        >
          {plan.safety.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      )}

      <div className="flex items-start gap-2 rounded-md border border-border/30 bg-muted/15 px-3 py-2">
        <input
          checked={confirmed}
          className="mt-0.5 size-4 accent-primary"
          disabled={!plan.canApply}
          id={confirmId}
          onChange={(event) => onConfirmedChange(event.target.checked)}
          type="checkbox"
        />
        <label className="text-[13px] leading-snug" htmlFor={confirmId}>
          Confirm exact plan digest{" "}
          <span className="font-mono text-[11px] text-muted-foreground">
            {shortDigest(plan.planDigest)}
          </span>
        </label>
      </div>

      {outcomeMessage && (
        <div
          aria-live="assertive"
          className={`rounded-md border px-3 py-2 text-sm ${outcomeClass}`}
          role="alert"
        >
          {outcomeMessage}
        </div>
      )}
    </div>
  );
}
