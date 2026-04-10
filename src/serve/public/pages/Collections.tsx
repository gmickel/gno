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
  CpuIcon,
  DatabaseIcon,
  FileTextIcon,
  FolderIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  HomeIcon,
  LayersIcon,
  Loader2Icon,
  MoreVerticalIcon,
  RefreshCwIcon,
  Share2Icon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { AppStatusResponse } from "../../status-model";

import { AddCollectionDialog } from "../components/AddCollectionDialog";
import { Loader } from "../components/ai-elements/loader";
import {
  CollectionModelDialog,
  type CollectionModelDetails,
} from "../components/CollectionModelDialog";
import { CollectionsEmptyState } from "../components/CollectionsEmptyState";
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
import {
  downloadPublishArtifactFile,
  type PublishExportResponse,
} from "../lib/publish-export";

interface PageProps {
  navigate: (to: string | number) => void;
}

interface CollectionStats {
  activePresetId?: string;
  name: string;
  path: string;
  documentCount: number;
  chunkCount: number;
  embeddedCount: number;
  include?: string[];
  models?: Partial<Record<"embed" | "rerank" | "expand" | "gen", string>>;
  effectiveModels?: Record<"embed" | "rerank" | "expand" | "gen", string>;
  modelSources?: Record<
    "embed" | "rerank" | "expand" | "gen",
    "override" | "preset" | "default"
  >;
  pattern?: string;
}

interface StatusResponse {
  collections: CollectionStats[];
  totalDocuments: number;
  lastUpdated: string | null;
  healthy: boolean;
  onboarding: AppStatusResponse["onboarding"];
}

interface SyncResponse {
  jobId: string;
}

interface EmbeddingCleanupResponse {
  note?: string;
  stats: {
    collection: string;
    deletedVectors: number;
    deletedModels: string[];
    mode: "stale" | "all";
    protectedSharedVectors: number;
  };
  success: boolean;
}

interface CollectionsResponseItem extends CollectionModelDetails {}

interface CollectionCardProps {
  actionsDisabled: boolean;
  collection: CollectionStats;
  onBrowse: () => void;
  onEmbeddingCleanup: () => void;
  onExport: () => void;
  onModelSettings: () => void;
  onReindex: () => void;
  onRemove: () => void;
  isExporting: boolean;
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
  onEmbeddingCleanup,
  onExport,
  onModelSettings,
  onReindex,
  onRemove,
  isExporting,
  isReindexing,
}: CollectionCardProps) {
  const embedPercent =
    collection.chunkCount > 0
      ? Math.round((collection.embeddedCount / collection.chunkCount) * 100)
      : 100;

  return (
    <Card
      className="group relative cursor-pointer overflow-hidden transition-all duration-300 hover:border-primary/30 hover:bg-card/90 hover:shadow-[0_0_30px_-12px_hsl(var(--primary)/0.15)]"
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
                disabled={actionsDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  onModelSettings();
                }}
              >
                <CpuIcon className="mr-2 size-4" />
                Model settings
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={actionsDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  onEmbeddingCleanup();
                }}
              >
                <DatabaseIcon className="mr-2 size-4" />
                Embedding cleanup
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={actionsDisabled || isExporting}
                onClick={(event) => {
                  event.stopPropagation();
                  onExport();
                }}
              >
                {isExporting ? (
                  <Loader2Icon className="mr-2 size-4 animate-spin" />
                ) : (
                  <Share2Icon className="mr-2 size-4" />
                )}
                Export for gno.sh
              </DropdownMenuItem>
              <DropdownMenuSeparator />
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

        {collection.modelSources ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-border/30 border-t pt-3">
            {(["embed", "rerank", "expand", "gen"] as const).map((role) => {
              const source = collection.modelSources?.[role];
              if (source !== "override") {
                return null;
              }

              return (
                <Badge
                  className="font-mono text-[10px] uppercase tracking-[0.12em]"
                  key={role}
                  variant="secondary"
                >
                  {role} override
                </Badge>
              );
            })}
          </div>
        ) : null}

        <div className="mt-3 border-border/40 border-t pt-3 text-muted-foreground text-xs">
          Click card to browse documents in this collection.
        </div>
      </CardContent>
    </Card>
  );
}

export default function Collections({ navigate }: PageProps) {
  const [collections, setCollections] = useState<CollectionStats[]>([]);
  const [onboarding, setOnboarding] = useState<
    AppStatusResponse["onboarding"] | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [syncTarget, setSyncTarget] = useState<SyncTarget>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportingCollectionName, setExportingCollectionName] = useState<
    string | null
  >(null);
  const [removeDialog, setRemoveDialog] = useState<CollectionStats | null>(
    null
  );
  const [embeddingCleanupDialog, setEmbeddingCleanupDialog] =
    useState<CollectionStats | null>(null);
  const [embeddingCleanupBusy, setEmbeddingCleanupBusy] = useState<
    "stale" | "all" | null
  >(null);
  const [embeddingCleanupNote, setEmbeddingCleanupNote] = useState<
    string | null
  >(null);
  const [removing, setRemoving] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [modelDialogCollection, setModelDialogCollection] =
    useState<CollectionStats | null>(null);
  const [initialCollectionPath, setInitialCollectionPath] = useState<
    string | undefined
  >(undefined);

  const loadCollections = useCallback(async () => {
    const [statusResult, collectionsResult] = await Promise.all([
      apiFetch<StatusResponse>("/api/status"),
      apiFetch<CollectionsResponseItem[]>("/api/collections"),
    ]);

    if (statusResult.error) {
      setError(statusResult.error);
      return;
    }

    if (!statusResult.data) {
      return;
    }

    const collectionsByName = new Map(
      (collectionsResult.data ?? []).map((item) => [item.name, item] as const)
    );
    const merged = statusResult.data.collections.map((collection) => {
      const config = collectionsByName.get(collection.name);
      return {
        ...collection,
        activePresetId: config?.activePresetId,
        effectiveModels: config?.effectiveModels,
        include: config?.include,
        models: config?.models,
        modelSources: config?.modelSources,
        pattern: config?.pattern,
      };
    });

    setCollections(merged);
    setOnboarding(statusResult.data.onboarding);
    setError(collectionsResult.error ?? null);
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

  const handleEmbeddingCleanup = async (mode: "stale" | "all") => {
    if (!embeddingCleanupDialog) return;

    setEmbeddingCleanupBusy(mode);
    setEmbeddingCleanupNote(null);

    const { data, error: err } = await apiFetch<EmbeddingCleanupResponse>(
      `/api/collections/${encodeURIComponent(embeddingCleanupDialog.name)}/embeddings/clear`,
      {
        method: "POST",
        body: JSON.stringify({ mode }),
      }
    );

    setEmbeddingCleanupBusy(null);

    if (err) {
      setEmbeddingCleanupNote(err);
      return;
    }

    setEmbeddingCleanupNote(
      data?.note ??
        `Cleared ${data?.stats.deletedVectors ?? 0} embedding(s) for ${embeddingCleanupDialog.name}.`
    );
    await loadCollections();
  };

  const handleExport = async (name: string) => {
    setExportError(null);
    setExportingCollectionName(name);

    const { data, error: err } = await apiFetch<PublishExportResponse>(
      "/api/publish/export",
      {
        body: JSON.stringify({ target: name }),
        method: "POST",
      }
    );

    setExportingCollectionName(null);

    if (err) {
      setExportError(err);
      return;
    }

    if (data) {
      downloadPublishArtifactFile(data);
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
                className="gap-2 text-primary"
                onClick={() => navigate("/")}
                size="sm"
                variant="ghost"
              >
                <HomeIcon className="size-4" />
                GNO
              </Button>
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

        {exportError && (
          <Card className="mx-auto mb-6 max-w-3xl border-destructive bg-destructive/10">
            <CardContent className="py-4">
              <p className="text-destructive text-sm">{exportError}</p>
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
          <CollectionsEmptyState
            onAddCollection={(path) => {
              setInitialCollectionPath(path);
              setAddDialogOpen(true);
            }}
            suggestedCollections={onboarding?.suggestedCollections ?? []}
          />
        )}

        {/* Collections grid */}
        {!error && collections.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {collections.map((collection) => (
              <CollectionCard
                actionsDisabled={Boolean(syncJobId)}
                collection={collection}
                isExporting={exportingCollectionName === collection.name}
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
                onEmbeddingCleanup={() => {
                  setEmbeddingCleanupDialog(collection);
                  setEmbeddingCleanupNote(null);
                }}
                onExport={() => {
                  void handleExport(collection.name);
                }}
                onModelSettings={() => setModelDialogCollection(collection)}
                onReindex={() => void handleReindex(collection.name)}
                onRemove={() => setRemoveDialog(collection)}
              />
            ))}
          </div>
        )}
      </main>

      {/* Add collection dialog */}
      <AddCollectionDialog
        initialPath={initialCollectionPath}
        onOpenChange={setAddDialogOpen}
        onSuccess={() => void loadCollections()}
        open={addDialogOpen}
      />

      <CollectionModelDialog
        collection={modelDialogCollection}
        onOpenChange={(open) => {
          if (!open) {
            setModelDialogCollection(null);
          }
        }}
        onSaved={() => void loadCollections()}
        open={!!modelDialogCollection}
      />

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setEmbeddingCleanupDialog(null);
            setEmbeddingCleanupBusy(null);
            setEmbeddingCleanupNote(null);
          }
        }}
        open={!!embeddingCleanupDialog}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Embedding cleanup</DialogTitle>
            <DialogDescription>
              Remove stale embeddings or clear all embeddings for{" "}
              <strong>{embeddingCleanupDialog?.name}</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border border-border/40 bg-card/70 p-3">
              <p className="font-medium">Clear stale embeddings</p>
              <p className="mt-1 text-muted-foreground">
                Removes embeddings for models that are not the currently active
                embed model for this collection.
              </p>
            </div>
            <div className="rounded-lg border border-secondary/30 bg-secondary/8 p-3">
              <p className="font-medium text-secondary">Clear all embeddings</p>
              <p className="mt-1 text-muted-foreground">
                Removes every embedding for this collection. You will need to
                run embeddings again afterward.
              </p>
            </div>
            {embeddingCleanupNote ? (
              <div className="rounded-lg border border-border/40 bg-card/70 p-3 text-muted-foreground">
                {embeddingCleanupNote}
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              onClick={() => {
                setEmbeddingCleanupDialog(null);
                setEmbeddingCleanupBusy(null);
                setEmbeddingCleanupNote(null);
              }}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={embeddingCleanupBusy !== null}
              onClick={() => void handleEmbeddingCleanup("stale")}
              variant="outline"
            >
              {embeddingCleanupBusy === "stale" ? (
                <Loader2Icon className="mr-1.5 size-4 animate-spin" />
              ) : null}
              Clear stale
            </Button>
            <Button
              disabled={embeddingCleanupBusy !== null}
              onClick={() => void handleEmbeddingCleanup("all")}
              variant="destructive"
            >
              {embeddingCleanupBusy === "all" ? (
                <Loader2Icon className="mr-1.5 size-4 animate-spin" />
              ) : null}
              Clear all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
