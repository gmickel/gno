import {
  ArrowLeftIcon,
  DownloadIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  RetrievalTraceDetail,
  RetrievalTraceExportResult,
  RetrievalTraceLabelResult,
  RetrievalTraceListResult,
  RetrievalTracePurgeResult,
} from "../../../core/retrieval-trace-management";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { apiFetch } from "../hooks/use-api";
import {
  TraceEvidenceList,
  type TraceEvidenceSelection,
  TraceLabelForm,
  TracePurgeNotice,
} from "./trace-history-detail";

interface PageProps {
  navigate: (to: string | number) => void;
}

type ConfirmAction =
  | { kind: "delete"; traceId: string }
  | { kind: "purge" }
  | null;

const statusVariant = (
  status: string
): "default" | "destructive" | "outline" | "secondary" => {
  if (status === "completed") return "default";
  if (status === "failed" || status === "cancelled") return "destructive";
  if (status === "partial") return "secondary";
  return "outline";
};

const downloadJson = (value: unknown, filename: string): void => {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

export default function TraceHistory({ navigate }: PageProps) {
  const [history, setHistory] = useState<RetrievalTraceListResult | null>(null);
  const [detail, setDetail] = useState<RetrievalTraceDetail | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>("list");
  const [error, setError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [label, setLabel] = useState<
    "relevant" | "irrelevant" | "missing_expected"
  >("relevant");
  const [targetRef, setTargetRef] = useState("");
  const [sourceHash, setSourceHash] = useState("");
  const [selectedEvidence, setSelectedEvidence] =
    useState<TraceEvidenceSelection | null>(null);
  const [purgeReceipt, setPurgeReceipt] =
    useState<RetrievalTracePurgeResult | null>(null);

  const loadHistory = useCallback(async (): Promise<void> => {
    setBusy("list");
    setError(null);
    const result = await apiFetch<RetrievalTraceListResult>(
      "/api/traces?limit=100"
    );
    if (result.error) {
      setError(result.error);
    } else {
      setHistory(result.data);
      const ids = new Set(result.data?.traces.map((trace) => trace.traceId));
      setSelected(
        (current) => new Set([...current].filter((traceId) => ids.has(traceId)))
      );
    }
    setBusy(null);
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const inspect = useCallback(async (traceId: string): Promise<void> => {
    setBusy(`show:${traceId}`);
    setError(null);
    const result = await apiFetch<RetrievalTraceDetail>(
      `/api/traces/${encodeURIComponent(traceId)}?detailLimit=500`
    );
    setSelectedEvidence(null);
    setTargetRef("");
    setSourceHash("");
    setDetail(result.data);
    setError(result.error);
    setBusy(null);
  }, []);

  const submitLabel = async (): Promise<void> => {
    if (!detail || !targetRef.trim()) return;
    setBusy("label");
    setError(null);
    const result = await apiFetch<RetrievalTraceLabelResult>(
      `/api/traces/${encodeURIComponent(detail.trace.traceId)}/judgments`,
      {
        method: "POST",
        body: JSON.stringify({
          label,
          targetRef: targetRef.trim(),
          ...(label !== "missing_expected" &&
          selectedEvidence?.ref === targetRef.trim()
            ? {
                targetKind: selectedEvidence.targetKind,
                startLine: selectedEvidence.startLine,
                endLine: selectedEvidence.endLine,
                sourceHash: selectedEvidence.sourceHash,
                docid: selectedEvidence.docid,
              }
            : {}),
          ...(label === "missing_expected" && sourceHash.trim()
            ? { sourceHash: sourceHash.trim() }
            : {}),
        }),
      }
    );
    if (result.error) {
      setError(result.error);
    } else {
      setTargetRef("");
      setSourceHash("");
      setSelectedEvidence(null);
      await inspect(detail.trace.traceId);
    }
    setBusy(null);
  };

  const exportSelected = async (): Promise<void> => {
    if (selected.size === 0) return;
    setBusy("export");
    setError(null);
    const result = await apiFetch<RetrievalTraceExportResult>(
      "/api/traces/export",
      {
        method: "POST",
        body: JSON.stringify({
          traceIds: [...selected],
          format: "agentic-receipt",
        }),
      }
    );
    if (result.data) {
      downloadJson(
        result.data.artifact,
        `gno-traces-${result.data.manifest.artifactHash.slice(0, 12)}.json`
      );
    }
    setError(result.error);
    setBusy(null);
  };

  const runConfirmedAction = async (): Promise<void> => {
    if (!confirmAction) return;
    const action = confirmAction;
    setConfirmAction(null);
    setBusy(action.kind);
    setError(null);
    const endpoint =
      action.kind === "purge"
        ? "/api/traces"
        : `/api/traces/${encodeURIComponent(action.traceId)}`;
    const result = await apiFetch<RetrievalTracePurgeResult>(endpoint, {
      method: "DELETE",
    });
    if (result.error) {
      setError(result.error);
    } else {
      if (action.kind === "purge") setPurgeReceipt(result.data);
      setDetail(null);
      setSelected(new Set());
      await loadHistory();
    }
    setBusy(null);
  };

  const terminalSelected = useMemo(() => {
    const byId = new Map(
      history?.traces.map((trace) => [trace.traceId, trace]) ?? []
    );
    return [...selected].every(
      (traceId) => byId.get(traceId)?.status !== "open"
    );
  }, [history, selected]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between p-6">
          <div className="flex items-center gap-4">
            <Button
              aria-label="Back"
              onClick={() => navigate(-1)}
              size="icon"
              variant="ghost"
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
            <div>
              <h1 className="font-display text-2xl font-semibold">
                Trace history
              </h1>
              <p className="text-sm text-muted-foreground">
                Private receipts. Local evidence. Explicit feedback only.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              disabled={busy !== null}
              onClick={() => void loadHistory()}
              variant="outline"
            >
              <RefreshCwIcon className="mr-2 size-4" />
              Refresh
            </Button>
            <Button
              disabled={
                busy !== null || selected.size === 0 || !terminalSelected
              }
              onClick={() => void exportSelected()}
            >
              <DownloadIcon className="mr-2 size-4" />
              Export {selected.size || ""}
            </Button>
            <Button
              disabled={busy !== null || !history?.traces.length}
              onClick={() => setConfirmAction({ kind: "purge" })}
              variant="destructive"
            >
              <Trash2Icon className="mr-2 size-4" />
              Purge all
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 p-6 lg:grid-cols-[1.35fr_1fr]">
        <div className="lg:col-span-2">
          <TracePurgeNotice receipt={purgeReceipt} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheckIcon className="size-5 text-primary" />
              Local receipts
            </CardTitle>
          </CardHeader>
          <CardContent>
            {error && (
              <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            {busy === "list" && !history ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground">
                <Loader2Icon className="mr-2 size-5 animate-spin" />
                Loading traces
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">Use</TableHead>
                    <TableHead>Trace</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history?.traces.map((trace) => (
                    <TableRow
                      className="cursor-pointer"
                      key={trace.traceId}
                      onClick={() => void inspect(trace.traceId)}
                    >
                      <TableCell>
                        <input
                          aria-label={`Select ${trace.traceId}`}
                          checked={selected.has(trace.traceId)}
                          onChange={(event) => {
                            event.stopPropagation();
                            setSelected((current) => {
                              const next = new Set(current);
                              if (next.has(trace.traceId)) {
                                next.delete(trace.traceId);
                              } else {
                                next.add(trace.traceId);
                              }
                              return next;
                            });
                          }}
                          onClick={(event) => event.stopPropagation()}
                          type="checkbox"
                        />
                      </TableCell>
                      <TableCell className="max-w-48 truncate font-mono text-xs">
                        {trace.traceId}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(trace.status)}>
                          {trace.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{trace.redactionMode}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(trace.createdAtMs).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Receipt detail</CardTitle>
          </CardHeader>
          <CardContent>
            {!detail ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                Select a trace to inspect bounded evidence and add explicit
                feedback.
              </p>
            ) : (
              <div className="space-y-5">
                <div className="space-y-1 text-sm">
                  <div className="break-all font-mono text-xs">
                    {detail.trace.traceId}
                  </div>
                  <div className="flex gap-2">
                    <Badge variant={statusVariant(detail.trace.status)}>
                      {detail.trace.status}
                    </Badge>
                    <Badge variant="outline">
                      {detail.trace.redactionMode}
                    </Badge>
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-2 text-center text-xs">
                  {(
                    [
                      ["Runs", detail.runs.length],
                      ["Events", detail.events.length],
                      ["Labels", detail.judgments.length],
                      ["Exports", detail.exports.length],
                    ] as const
                  ).map(([name, count]) => (
                    <div className="rounded-md bg-muted p-2" key={name}>
                      <div className="font-semibold">{count}</div>
                      <div className="text-muted-foreground">{name}</div>
                    </div>
                  ))}
                </div>

                <TraceEvidenceList
                  detail={detail}
                  onSelect={(selection) => {
                    setSelectedEvidence(selection);
                    setTargetRef(selection.ref);
                    setSourceHash(selection.sourceHash ?? "");
                  }}
                />

                <TraceLabelForm
                  busy={busy === "label"}
                  label={label}
                  onLabelChange={setLabel}
                  onSourceHashChange={setSourceHash}
                  onSubmit={() => void submitLabel()}
                  onTargetRefChange={(value) => {
                    setTargetRef(value);
                    setSelectedEvidence(null);
                  }}
                  sourceHash={sourceHash}
                  targetRef={targetRef}
                />

                <Button
                  className="w-full"
                  onClick={() =>
                    setConfirmAction({
                      kind: "delete",
                      traceId: detail.trace.traceId,
                    })
                  }
                  variant="destructive"
                >
                  <Trash2Icon className="mr-2 size-4" />
                  Delete this trace
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        open={confirmAction !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction?.kind === "purge"
                ? "Purge every retrieval trace?"
                : "Delete this retrieval trace?"}
            </DialogTitle>
            <DialogDescription>
              This removes local receipt data and cannot be undone. Source
              documents are not changed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setConfirmAction(null)} variant="outline">
              Cancel
            </Button>
            <Button
              onClick={() => void runConfirmedAction()}
              variant="destructive"
            >
              Delete local receipts
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
