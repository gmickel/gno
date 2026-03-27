/**
 * IndexingProgress - Displays job progress with polling.
 *
 * Features:
 * - Polls /api/jobs/:id at regular intervals
 * - Shows running/completed/failed states
 * - Displays elapsed time and summary on completion
 * - Compact and expanded variants
 */

import {
  AlertCircleIcon,
  CheckCircle2Icon,
  FileTextIcon,
  Loader2Icon,
  TimerIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../hooks/use-api";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

export interface JobStatus {
  id: string;
  type: "add" | "sync";
  status: "running" | "completed" | "failed";
  createdAt: number;
  result?: SyncResult;
  error?: string;
}

interface SyncResult {
  collections: CollectionResult[];
  totalDurationMs: number;
  totalFilesProcessed: number;
  totalFilesAdded: number;
  totalFilesUpdated: number;
  totalFilesErrored: number;
  totalFilesSkipped: number;
}

interface CollectionResult {
  collection: string;
  filesProcessed: number;
  filesAdded: number;
  filesUpdated: number;
  filesUnchanged: number;
  filesErrored: number;
  durationMs: number;
}

function isNoopSyncResult(result: SyncResult | undefined): boolean {
  if (!result) {
    return false;
  }

  return (
    result.totalFilesProcessed === 0 &&
    result.totalFilesAdded === 0 &&
    result.totalFilesUpdated === 0 &&
    result.totalFilesErrored === 0
  );
}

export interface IndexingProgressProps {
  /** Job ID to poll */
  jobId: string;
  /** Called when job completes successfully */
  onComplete?: (result: SyncResult) => void;
  /** Called when job fails */
  onError?: (error: string) => void;
  /** Compact mode for inline display */
  compact?: boolean;
  /** Additional CSS classes */
  className?: string;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export function IndexingProgress({
  jobId,
  onComplete,
  onError,
  compact = false,
  className,
}: IndexingProgressProps) {
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );
  const completedRef = useRef(false);

  // Poll job status
  const poll = useCallback(async () => {
    const { data, error: err } = await apiFetch<JobStatus>(
      `/api/jobs/${encodeURIComponent(jobId)}`
    );

    if (err) {
      setFetchError(err);
      return;
    }

    if (!data) {
      setFetchError("No response from server");
      return;
    }

    setStatus(data);
    setFetchError(null);

    // Handle terminal states
    if (data.status === "completed") {
      if (!completedRef.current && data.result) {
        completedRef.current = true;
        onComplete?.(data.result);
      }
    } else if (data.status === "failed") {
      if (!completedRef.current) {
        completedRef.current = true;
        onError?.(data.error ?? "Unknown error");
      }
    } else if (data.status === "running") {
      // Continue polling
      pollTimeoutRef.current = setTimeout(() => {
        void poll();
      }, 1000);
    }
  }, [jobId, onComplete, onError]);

  // Start polling on mount
  useEffect(() => {
    completedRef.current = false;
    void poll();

    // Track elapsed time
    const startTime = Date.now();
    elapsedIntervalRef.current = setInterval(() => {
      setElapsed(Date.now() - startTime);
    }, 1000);

    return () => {
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
      }
      if (elapsedIntervalRef.current) {
        clearInterval(elapsedIntervalRef.current);
      }
    };
  }, [poll]);

  // Stop elapsed timer when complete
  useEffect(() => {
    if (status?.status !== "running" && elapsedIntervalRef.current) {
      clearInterval(elapsedIntervalRef.current);
    }
  }, [status?.status]);

  // Loading/error before first status
  if (!status && !fetchError) {
    return (
      <div className={cn("flex items-center gap-2 text-sm", className)}>
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground">Loading...</span>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-destructive text-sm",
          className
        )}
      >
        <AlertCircleIcon className="size-4" />
        <span>{fetchError}</span>
      </div>
    );
  }

  // Compact mode
  if (compact) {
    if (status?.status === "running") {
      return (
        <div
          aria-live="polite"
          className={cn("flex items-center gap-2 text-sm", className)}
        >
          <Loader2Icon className="size-4 animate-spin text-primary" />
          <span className="text-muted-foreground">
            Indexing... {formatElapsed(elapsed)}
          </span>
        </div>
      );
    }

    if (status?.status === "completed") {
      const result = status.result;
      return (
        <div
          aria-live="polite"
          className={cn("flex items-center gap-2 text-sm", className)}
        >
          <CheckCircle2Icon className="size-4 text-green-500" />
          <span className="text-muted-foreground">
            {isNoopSyncResult(result)
              ? "Up to date"
              : `${result?.totalFilesProcessed ?? 0} files in ${formatDuration(result?.totalDurationMs ?? 0)}`}
          </span>
        </div>
      );
    }

    if (status?.status === "failed") {
      return (
        <div
          aria-live="assertive"
          className={cn("flex items-center gap-2 text-sm", className)}
        >
          <AlertCircleIcon className="size-4 text-destructive" />
          <span className="text-destructive">Failed</span>
        </div>
      );
    }
  }

  // Expanded mode (default)
  return (
    <div aria-live="polite" className={cn("space-y-3", className)}>
      {/* Status header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {status?.status === "running" && (
            <>
              <Loader2Icon className="size-5 animate-spin text-primary" />
              <span className="font-medium">Indexing in progress</span>
            </>
          )}
          {status?.status === "completed" && (
            <>
              <CheckCircle2Icon className="size-5 text-green-500" />
              <span className="font-medium text-green-500">
                Indexing complete
              </span>
            </>
          )}
          {status?.status === "failed" && (
            <>
              <AlertCircleIcon className="size-5 text-destructive" />
              <span className="font-medium text-destructive">
                Indexing failed
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-muted-foreground text-sm">
          <TimerIcon className="size-4" />
          <span>
            {status?.status === "running"
              ? formatElapsed(elapsed)
              : formatDuration(status?.result?.totalDurationMs ?? elapsed)}
          </span>
        </div>
      </div>

      {/* Error message */}
      {status?.status === "failed" && status.error && (
        <div className="rounded-lg bg-destructive/10 p-3 text-destructive text-sm">
          {status.error}
        </div>
      )}

      {/* Success summary */}
      {status?.status === "completed" && status.result && (
        <div className="space-y-2">
          {isNoopSyncResult(status.result) && (
            <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-green-500 text-sm">
              No file changes found. Workspace is already up to date.
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Badge className="gap-1" variant="outline">
              <FileTextIcon className="size-3" />
              {status.result.totalFilesProcessed} processed
            </Badge>
            {status.result.totalFilesAdded > 0 && (
              <Badge
                className="bg-green-500/20 text-green-500"
                variant="outline"
              >
                +{status.result.totalFilesAdded} added
              </Badge>
            )}
            {status.result.totalFilesUpdated > 0 && (
              <Badge className="bg-blue-500/20 text-blue-500" variant="outline">
                {status.result.totalFilesUpdated} updated
              </Badge>
            )}
            {status.result.totalFilesErrored > 0 && (
              <Badge
                className="bg-destructive/20 text-destructive"
                variant="outline"
              >
                {status.result.totalFilesErrored} errors
              </Badge>
            )}
          </div>

          {/* Per-collection breakdown */}
          {status.result.collections.length > 1 && (
            <div className="mt-2 space-y-1 border-border/50 border-t pt-2">
              {status.result.collections.map((col) => (
                <div
                  className="flex items-center justify-between text-muted-foreground text-sm"
                  key={col.collection}
                >
                  <span>{col.collection}</span>
                  <span>
                    {col.filesProcessed} files ·{" "}
                    {formatDuration(col.durationMs)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
