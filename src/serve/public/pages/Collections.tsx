/**
 * Collections page - List and manage document collections.
 *
 * Features:
 * - Grid of collection cards with stats
 * - Re-index action per collection
 * - Remove collection with confirmation
 * - Refresh button
 * - Empty state
 */

import {
  AlertCircleIcon,
  ArrowLeftIcon,
  DatabaseIcon,
  FileTextIcon,
  FolderIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  LayersIcon,
  Loader2Icon,
  MoreVerticalIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AddCollectionDialog } from "../components/AddCollectionDialog";
import { Loader } from "../components/ai-elements/loader";
import { IndexingProgress } from "../components/IndexingProgress";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { apiFetch } from "../hooks/use-api";

interface PageProps {
  navigate: (to: string | number) => void;
}

interface CollectionStats {
  name: string;
  path: string;
  documentCount: number;
  chunkCount: number;
  embeddedCount: number;
}

interface StatusResponse {
  collections: CollectionStats[];
  totalDocuments: number;
  lastUpdated: string | null;
  healthy: boolean;
}

interface SyncResponse {
  jobId: string;
}

interface CollectionCardProps {
  actionsDisabled: boolean;
  collection: CollectionStats;
  onBrowse: () => void;
  onReindex: () => void;
  onRemove: () => void;
  isReindexing: boolean;
}

type SyncTarget = { kind: "all" } | { kind: "collection"; name: string } | null;

function formatNumber(n: number): string {
  if (n >= 1000000) {
    return `${(n / 1000000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return n.toString();
}

function truncatePath(path: string, maxLength = 40): string {
  if (path.length <= maxLength) return path;
  const start = path.slice(0, 15);
  const end = path.slice(-22);
  return `${start}...${end}`;
}

function CollectionCard({
  actionsDisabled,
  collection,
  onBrowse,
  onReindex,
  onRemove,
  isReindexing,
}: CollectionCardProps) {
  const embedPercent =
    collection.chunkCount > 0
      ? Math.round((collection.embeddedCount / collection.chunkCount) * 100)
      : 100;

  return (
    <Card
      className="group relative cursor-pointer overflow-hidden transition-all hover:border-primary/30 hover:bg-card/90"
      onClick={onBrowse}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onBrowse();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div className="rounded-lg bg-primary/10 p-2">
              <FolderIcon className="size-5 text-primary" />
            </div>
            <CardTitle className="truncate text-lg">
              {collection.name}
            </CardTitle>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                disabled={actionsDisabled}
                onClick={(event) => event.stopPropagation()}
                size="icon-sm"
                variant="ghost"
              >
                <MoreVerticalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={actionsDisabled || isReindexing}
                onClick={(event) => {
                  event.stopPropagation();
                  onReindex();
                }}
              >
                {isReindexing ? (
                  <Loader2Icon className="mr-2 size-4 animate-spin" />
                ) : (
                  <RefreshCwIcon className="mr-2 size-4" />
                )}
                Re-index
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={actionsDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove();
                }}
              >
                <FolderMinusIcon className="mr-2 size-4" />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="truncate font-mono text-muted-foreground text-xs">
                {truncatePath(collection.path)}
              </p>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs break-all">
              <p className="font-mono text-xs">{collection.path}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </CardHeader>

      <CardContent className="pt-2">
        <div className="grid grid-cols-3 gap-3">
          <div className="flex items-center gap-2">
            <FileTextIcon className="size-4 text-muted-foreground" />
            <div>
              <div className="font-medium text-sm">
                {formatNumber(collection.documentCount)}
              </div>
              <div className="text-muted-foreground text-xs">documents</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LayersIcon className="size-4 text-muted-foreground" />
            <div>
              <div className="font-medium text-sm">
                {formatNumber(collection.chunkCount)}
              </div>
              <div className="text-muted-foreground text-xs">chunks</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <DatabaseIcon className="size-4 text-muted-foreground" />
            <div>
              <div className="font-medium text-sm">{embedPercent}%</div>
              <div className="text-muted-foreground text-xs">embedded</div>
            </div>
          </div>
        </div>

        {isReindexing && (
          <div className="mt-3 flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            <span>Re-indexing...</span>
          </div>
        )}

        <div className="mt-3 border-border/40 border-t pt-3 text-muted-foreground text-xs">
          Click card to browse documents in this collection.
        </div>
      </CardContent>
    </Card>
  );
}

export default function Collections({ navigate }: PageProps) {
  const [collections, setCollections] = useState<CollectionStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [syncTarget, setSyncTarget] = useState<SyncTarget>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [removeDialog, setRemoveDialog] = useState<CollectionStats | null>(
    null
  );
  const [removing, setRemoving] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const loadCollections = useCallback(async () => {
    const { data, error: err } = await apiFetch<StatusResponse>("/api/status");
    if (err) {
      setError(err);
    } else if (data) {
      setCollections(data.collections);
      setError(null);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void loadCollections().finally(() => setLoading(false));
  }, [loadCollections]);

  // Refresh
  const handleRefresh = async () => {
    setRefreshing(true);
    await loadCollections();
    setRefreshing(false);
  };

  // Re-index collection
  const handleReindex = async (name?: string) => {
    setSyncError(null);

    const { data, error: err } = await apiFetch<SyncResponse>("/api/sync", {
      method: "POST",
      body: JSON.stringify(name ? { collection: name } : {}),
    });

    if (err) {
      setSyncError(err);
      return;
    }

    if (data?.jobId) {
      setSyncJobId(data.jobId);
      setSyncTarget(name ? { kind: "collection", name } : { kind: "all" });
    }
  };

  // Remove collection
  const handleRemove = async () => {
    if (!removeDialog) return;

    setRemoving(true);
    const { error: err } = await apiFetch(
      `/api/collections/${encodeURIComponent(removeDialog.name)}`,
      { method: "DELETE" }
    );

    setRemoving(false);
    setRemoveDialog(null);

    if (!err) {
      await loadCollections();
    }
  };

  // Loading state
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader className="text-primary" size={32} />
          <p className="text-muted-foreground">Loading collections...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="glass sticky top-0 z-10 border-border/50 border-b">
        <div className="flex flex-wrap items-start justify-between gap-4 px-8 py-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                className="gap-2"
                onClick={() => navigate(-1)}
                size="sm"
                variant="ghost"
              >
                <ArrowLeftIcon className="size-4" />
                Back
              </Button>
              <FolderIcon className="size-5 text-primary" />
              <h1 className="font-semibold text-xl">Collections</h1>
              <Badge className="font-mono" variant="outline">
                {collections.length}
              </Badge>
            </div>
            <p className="max-w-2xl text-muted-foreground text-sm">
              Add new sources, re-index after external edits or git pulls, and
              retire old folders without losing indexed history.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={refreshing}
              onClick={handleRefresh}
              size="sm"
              variant="outline"
            >
              {refreshing ? (
                <Loader2Icon className="mr-1.5 size-4 animate-spin" />
              ) : (
                <RefreshCwIcon className="mr-1.5 size-4" />
              )}
              Refresh
            </Button>
            <Button
              className="gap-2"
              disabled={Boolean(syncJobId) || collections.length === 0}
              onClick={() => void handleReindex()}
              size="sm"
              variant="outline"
            >
              <RefreshCwIcon className="size-4" />
              Re-index All
            </Button>
            <Button onClick={() => setAddDialogOpen(true)} size="sm">
              <FolderPlusIcon className="mr-1.5 size-4" />
              Add Collection
            </Button>
          </div>
        </div>
      </header>

      <main className="p-8">
        {(syncJobId || syncError) && (
          <Card className="mx-auto mb-6 max-w-3xl border-primary/20 bg-card/80">
            <CardContent className="py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-medium text-sm tracking-[0.18em] uppercase">
                    Re-index
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {syncTarget?.kind === "all"
                      ? "Refreshing every configured collection."
                      : `Refreshing ${syncTarget?.name ?? "selected collection"}.`}
                  </p>
                </div>
                {syncJobId ? (
                  <IndexingProgress
                    compact
                    jobId={syncJobId}
                    onComplete={() => {
                      setSyncError(null);
                      setSyncJobId(null);
                      setSyncTarget(null);
                      void loadCollections();
                    }}
                    onError={(message) => {
                      setSyncError(message);
                      setSyncJobId(null);
                      setSyncTarget(null);
                    }}
                  />
                ) : (
                  <p className="text-destructive text-sm">{syncError}</p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Error */}
        {error && (
          <Card className="mx-auto mb-6 max-w-md border-destructive bg-destructive/10">
            <CardContent className="py-4 text-center">
              <AlertCircleIcon className="mx-auto mb-2 size-8 text-destructive" />
              <p className="text-destructive">{error}</p>
              <Button
                className="mt-3"
                onClick={() => void loadCollections()}
                size="sm"
                variant="outline"
              >
                Retry
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Empty state */}
        {!error && collections.length === 0 && (
          <div className="mx-auto max-w-md py-16 text-center">
            <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-muted">
              <FolderIcon className="size-8 text-muted-foreground" />
            </div>
            <h2 className="mb-2 font-semibold text-xl">No collections yet</h2>
            <p className="mb-6 text-muted-foreground">
              Add your first collection to start indexing documents.
            </p>
            <Button onClick={() => setAddDialogOpen(true)}>
              <FolderPlusIcon className="mr-2 size-4" />
              Add Collection
            </Button>
          </div>
        )}

        {/* Collections grid */}
        {!error && collections.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {collections.map((collection) => (
              <CollectionCard
                actionsDisabled={Boolean(syncJobId)}
                collection={collection}
                isReindexing={
                  Boolean(syncJobId) &&
                  syncTarget?.kind === "collection" &&
                  syncTarget.name === collection.name
                }
                key={collection.name}
                onBrowse={() =>
                  navigate(
                    `/browse?collection=${encodeURIComponent(collection.name)}`
                  )
                }
                onReindex={() => void handleReindex(collection.name)}
                onRemove={() => setRemoveDialog(collection)}
              />
            ))}
          </div>
        )}
      </main>

      {/* Add collection dialog */}
      <AddCollectionDialog
        onOpenChange={setAddDialogOpen}
        onSuccess={() => void loadCollections()}
        open={addDialogOpen}
      />

      {/* Remove confirmation dialog */}
      <Dialog
        onOpenChange={(open) => !open && setRemoveDialog(null)}
        open={!!removeDialog}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove collection</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove{" "}
              <strong>{removeDialog?.name}</strong>? Indexed documents will be
              kept in the database but won't appear in searches.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button onClick={() => setRemoveDialog(null)} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={removing}
              onClick={handleRemove}
              variant="destructive"
            >
              {removing && (
                <Loader2Icon className="mr-1.5 size-4 animate-spin" />
              )}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
