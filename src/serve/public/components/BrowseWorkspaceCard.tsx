import { ChevronRight } from "lucide-react";
import { Fragment } from "react";

import { IndexingProgress } from "./IndexingProgress";
import { Badge } from "./ui/badge";

export function BrowseWorkspaceCard({
  crumbs,
  navigate,
  selectedCollection,
  syncError,
  syncJobId,
  syncTarget,
  onSyncComplete,
  onSyncError,
}: {
  crumbs: Array<{ label: string; location: string }>;
  navigate: (to: string | number) => void;
  selectedCollection: string;
  syncError: string | null;
  syncJobId: string | null;
  syncTarget:
    | {
        kind: "all";
      }
    | {
        kind: "collection";
        name: string;
      }
    | null;
  onSyncComplete: () => void;
  onSyncError: (error: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card/70 p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="font-medium text-sm tracking-[0.18em] uppercase">
            Collection Controls
          </p>
          <p className="max-w-2xl text-muted-foreground text-sm">
            Navigate collections and folders from the tree, then use the detail
            pane to open notes, inspect folders, and re-index the active
            collection after external edits.
          </p>
          {selectedCollection ? (
            <div className="flex flex-wrap items-center gap-2">
              {crumbs.map((crumb, index) => (
                <Fragment key={crumb.location}>
                  <button
                    className="rounded px-2 py-1 font-mono text-xs transition-colors hover:bg-muted/60 hover:text-primary"
                    onClick={() => navigate(crumb.location)}
                    type="button"
                  >
                    {crumb.label}
                  </button>
                  {index < crumbs.length - 1 && (
                    <ChevronRight className="size-3 text-muted-foreground" />
                  )}
                </Fragment>
              ))}
            </div>
          ) : (
            <Badge className="font-mono text-xs" variant="secondary">
              All collections
            </Badge>
          )}
        </div>

        <div className="flex min-h-9 items-center">
          {syncJobId ? (
            <IndexingProgress
              className="justify-end"
              compact
              jobId={syncJobId}
              onComplete={onSyncComplete}
              onError={onSyncError}
            />
          ) : syncError ? (
            <p className="text-destructive text-sm">{syncError}</p>
          ) : syncTarget ? (
            <p className="text-muted-foreground text-sm">
              Re-index queued for{" "}
              <span className="font-medium text-foreground">
                {syncTarget.kind === "all"
                  ? "all collections"
                  : syncTarget.name}
              </span>
              .
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
