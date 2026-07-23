import { Loader2Icon } from "lucide-react";

import type {
  RetrievalTraceDetail,
  RetrievalTracePurgeResult,
} from "../../../core/retrieval-trace-management";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

export interface TraceEvidenceSelection {
  ref: string;
  targetKind: "document" | "chunk" | "span";
  startLine?: number;
  endLine?: number;
  sourceHash?: string;
  docid?: string;
}

const evidenceFromPayload = (
  payload: Record<string, unknown>
): TraceEvidenceSelection[] => {
  const selections: TraceEvidenceSelection[] = [];
  for (const key of ["ranked", "evidence"] as const) {
    const values = payload[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const target = value as Record<string, unknown>;
      const ref = [
        target.uri,
        target.docid,
        target.sourceHash,
        target.mirrorHash,
        target.passageHash,
      ].find((candidate): candidate is string => typeof candidate === "string");
      if (!ref) continue;
      const startLine =
        typeof target.startLine === "number" ? target.startLine : undefined;
      const endLine =
        typeof target.endLine === "number" ? target.endLine : undefined;
      const seq = typeof target.seq === "number" ? target.seq : undefined;
      selections.push({
        ref,
        targetKind:
          startLine !== undefined && endLine !== undefined
            ? "span"
            : seq === undefined
              ? "document"
              : "chunk",
        ...(startLine === undefined ? {} : { startLine }),
        ...(endLine === undefined ? {} : { endLine }),
        ...(typeof target.sourceHash === "string"
          ? { sourceHash: target.sourceHash }
          : {}),
        ...(typeof target.docid === "string" ? { docid: target.docid } : {}),
      });
    }
  }
  return selections;
};

export const traceEvidenceSelections = (
  detail: RetrievalTraceDetail
): TraceEvidenceSelection[] => {
  const unique = new Map<string, TraceEvidenceSelection>();
  for (const record of [...detail.runs, ...detail.events]) {
    for (const selection of evidenceFromPayload(record.payload)) {
      const key = JSON.stringify(selection);
      if (!unique.has(key)) unique.set(key, selection);
    }
  }
  return [...unique.values()];
};

export function TraceEvidenceList({
  detail,
  onSelect,
}: {
  detail: RetrievalTraceDetail;
  onSelect: (selection: TraceEvidenceSelection) => void;
}) {
  const selections = traceEvidenceSelections(detail);
  return (
    <div className="space-y-3 border-t border-border/50 pt-4">
      <div>
        <h2 className="font-medium">Recorded evidence</h2>
        <p className="text-xs text-muted-foreground">
          Select a document, chunk, or exact line span to label.
        </p>
      </div>
      {selections.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No bounded evidence references were retained for this trace.
        </p>
      ) : (
        <div className="max-h-56 space-y-2 overflow-y-auto">
          {selections.map((selection) => (
            <div
              className="rounded-md border border-border/60 p-2"
              key={JSON.stringify(selection)}
            >
              <div className="break-all font-mono text-xs">{selection.ref}</div>
              <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {selection.targetKind}
                  {selection.startLine !== undefined &&
                    ` · lines ${selection.startLine}–${selection.endLine}`}
                </span>
                <Button
                  onClick={() => onSelect(selection)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Label this evidence
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TracePurgeNotice({
  receipt,
}: {
  receipt: RetrievalTracePurgeResult | null;
}) {
  if (!receipt) return null;
  const complete = receipt.physicalCleanup === "completed";
  return (
    <div
      className={`rounded-md border p-3 text-sm ${
        complete
          ? "border-emerald-500/40 bg-emerald-500/10"
          : "border-amber-500/40 bg-amber-500/10"
      }`}
      data-testid="trace-purge-receipt"
    >
      <div className="font-medium">
        {complete
          ? "Trace purge completed"
          : `Trace rows deleted; physical cleanup ${receipt.physicalCleanup.replace("_", " ")}`}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        Deleted {receipt.traces} traces, {receipt.runs} runs, {receipt.events}{" "}
        events, and {receipt.judgments} judgments.
        {!complete &&
          " Retry Full purge after active readers finish; the cleanup receipt remains visible until then."}
      </div>
    </div>
  );
}

export function TraceLabelForm({
  busy,
  label,
  onLabelChange,
  onSourceHashChange,
  onSubmit,
  onTargetRefChange,
  sourceHash,
  targetRef,
}: {
  busy: boolean;
  label: "relevant" | "irrelevant" | "missing_expected";
  onLabelChange: (
    value: "relevant" | "irrelevant" | "missing_expected"
  ) => void;
  onSourceHashChange: (value: string) => void;
  onSubmit: () => void;
  onTargetRefChange: (value: string) => void;
  sourceHash: string;
  targetRef: string;
}) {
  return (
    <div className="space-y-3 border-t border-border/50 pt-4">
      <h2 className="font-medium">Add explicit judgment</h2>
      <Select
        onValueChange={(value) =>
          onLabelChange(value as "relevant" | "irrelevant" | "missing_expected")
        }
        value={label}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="relevant">Relevant</SelectItem>
          <SelectItem value="irrelevant">Irrelevant</SelectItem>
          <SelectItem value="missing_expected">
            Missing expected document
          </SelectItem>
        </SelectContent>
      </Select>
      <Input
        onChange={(event) => onTargetRefChange(event.target.value)}
        placeholder="gno:// URI, docid, or recorded evidence ref"
        value={targetRef}
      />
      {label === "missing_expected" && (
        <Input
          onChange={(event) => onSourceHashChange(event.target.value)}
          placeholder="Optional immutable source SHA-256"
          value={sourceHash}
        />
      )}
      <Button disabled={!targetRef.trim() || busy} onClick={onSubmit} size="sm">
        {busy && <Loader2Icon className="mr-2 size-4 animate-spin" />}
        Record judgment
      </Button>
    </div>
  );
}
