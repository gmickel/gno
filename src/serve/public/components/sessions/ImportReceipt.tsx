import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleSlashIcon,
  EyeIcon,
  XCircleIcon,
} from "lucide-react";

import type { SessionImportReceipt, SessionUnitReceipt } from "./api";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";

const STATUS_COPY: Record<
  SessionImportReceipt["status"],
  { label: string; tone: string; Icon: typeof CheckCircle2Icon }
> = {
  complete: {
    label: "Complete",
    tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    Icon: CheckCircle2Icon,
  },
  partial: {
    label: "Partial — some units were not fully read",
    tone: "border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-200",
    Icon: AlertTriangleIcon,
  },
  failed: {
    label: "Failed",
    tone: "border-destructive/50 bg-destructive/10 text-destructive",
    Icon: XCircleIcon,
  },
  nothing_to_do: {
    label: "Nothing to do — everything is current",
    tone: "border-border bg-muted/40 text-muted-foreground",
    Icon: CircleSlashIcon,
  },
};

/** Unit outcomes worth listing individually (unchanged units are noise). */
const NOTABLE_OUTCOMES = new Set<SessionUnitReceipt["outcome"]>([
  "imported",
  "updated",
  "skipped_policy",
  "unsupported",
  "incomplete",
  "failed",
]);

const OUTCOME_TONE: Partial<Record<SessionUnitReceipt["outcome"], string>> = {
  incomplete: "text-amber-700 dark:text-amber-300",
  failed: "text-destructive",
  unsupported: "text-destructive",
  skipped_policy: "text-amber-700 dark:text-amber-300",
};

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="min-w-0 rounded-md border border-border/50 bg-muted/30 p-2">
      <dt className="break-words text-muted-foreground text-xs">{label}</dt>
      <dd className="font-mono font-semibold text-sm">{value}</dd>
    </div>
  );
}

export function ImportReceipt({ receipt }: { receipt: SessionImportReceipt }) {
  const status = STATUS_COPY[receipt.status];
  const { counts, turns } = receipt;
  const notable = receipt.units.filter((unit) =>
    NOTABLE_OUTCOMES.has(unit.outcome)
  );
  const destinations = [
    ...new Set(receipt.units.flatMap((unit) => unit.collections)),
  ].sort();

  return (
    <section
      aria-label={receipt.dryRun ? "Import preview" : "Import receipt"}
      className="min-w-0 space-y-4 rounded-lg border border-border/60 bg-card/60 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        {receipt.dryRun && (
          <Badge className="gap-1" variant="outline">
            <EyeIcon />
            Preview only — nothing was written
          </Badge>
        )}
        <span
          className={cn(
            "inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 font-medium text-sm",
            status.tone
          )}
          data-status={receipt.status}
          role="status"
        >
          <status.Icon aria-hidden="true" className="size-4 shrink-0" />
          <span className="break-words">{status.label}</span>
        </span>
        <span className="text-muted-foreground text-xs">
          Sources: {receipt.sourceIds.join(", ") || "—"} · index{" "}
          <span className="font-mono">{receipt.index}</span>
        </span>
      </div>

      <div>
        <h4 className="mb-1 font-medium text-sm">Threads and units</h4>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Imported" value={counts.imported} />
          <Stat label="Updated" value={counts.updated} />
          <Stat label="Unchanged" value={counts.unchanged} />
          <Stat label="Skipped by policy" value={counts.skippedPolicy} />
          <Stat label="Unsupported" value={counts.unsupported} />
          <Stat label="Incomplete" value={counts.incomplete} />
          <Stat label="Failed" value={counts.failed} />
          <Stat label="Deferred units" value={receipt.deferredUnits} />
        </dl>
      </div>

      <div>
        <h4 className="mb-1 font-medium text-sm">Turns and redaction</h4>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="Human turns" value={turns.human} />
          <Stat label="Assistant turns" value={turns.assistant} />
          <Stat label="Redactions" value={turns.redactions} />
          <Stat
            label="Injected context skipped"
            value={turns.injectedSkipped}
          />
          <Stat
            label="Copied history skipped"
            value={turns.copiedHistorySkipped}
          />
          <Stat label="Over limit" value={turns.overLimit} />
        </dl>
      </div>

      <p className="text-sm">
        <span className="text-muted-foreground">Destination collections: </span>
        {destinations.length > 0 ? (
          <span className="font-mono break-all">{destinations.join(", ")}</span>
        ) : (
          <span className="text-muted-foreground">none in this run</span>
        )}
      </p>

      {!receipt.dryRun && (
        <p className="text-sm">
          <span className="text-muted-foreground">Lexical search: </span>
          <span
            className={cn(
              "font-medium",
              receipt.lexical.status === "failed" && "text-destructive"
            )}
          >
            {receipt.lexical.status}
          </span>
          {receipt.lexical.error && (
            <span className="block break-words text-destructive text-xs">
              {receipt.lexical.error}
            </span>
          )}
          <span className="text-muted-foreground">
            {" "}
            · embedding backlog: {receipt.embedding.backlog ?? "n/a"}
          </span>
        </p>
      )}

      {receipt.warnings.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-amber-800 text-sm dark:text-amber-200">
          {receipt.warnings.map((warning) => (
            <li className="break-words" key={warning}>
              {warning}
            </li>
          ))}
        </ul>
      )}

      {notable.length > 0 && (
        <div className="min-w-0">
          <h4 className="mb-1 font-medium text-sm">Unit outcomes</h4>
          <ul className="divide-y divide-border/40 rounded-md border border-border/50">
            {notable.map((unit) => (
              <li
                className="min-w-0 space-y-0.5 p-2 text-sm"
                key={`${unit.sourceId}:${unit.locator}`}
              >
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span
                    className={cn(
                      "font-medium",
                      OUTCOME_TONE[unit.outcome] ?? "text-foreground"
                    )}
                  >
                    {unit.outcome.replace("_", " ")}
                  </span>
                  <span className="min-w-0 break-all font-mono text-xs">
                    {unit.locator}
                  </span>
                </div>
                <div className="text-muted-foreground text-xs">
                  {unit.threads} thread{unit.threads === 1 ? "" : "s"} ·{" "}
                  {unit.turns} turn{unit.turns === 1 ? "" : "s"}
                  {unit.collections.length > 0 &&
                    ` → ${unit.collections.join(", ")}`}
                  {unit.reason && ` · reason: ${unit.reason}`}
                </div>
                {unit.warnings?.map((warning) => (
                  <div
                    className="break-words text-amber-800 text-xs dark:text-amber-200"
                    key={warning}
                  >
                    {warning}
                  </div>
                ))}
              </li>
            ))}
          </ul>
          {receipt.unitsTruncated && (
            <p className="mt-1 text-muted-foreground text-xs">
              More units were processed than are listed here.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
