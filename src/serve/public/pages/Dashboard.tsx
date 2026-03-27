import {
  BookOpen,
  CheckCircle2Icon,
  CpuIcon,
  Database,
  DownloadIcon,
  FolderHeartIcon,
  FolderIcon,
  GitForkIcon,
  Layers,
  Loader2Icon,
  MessageSquare,
  PenIcon,
  RefreshCwIcon,
  Search,
  StarIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { AppStatusResponse, HealthActionKind } from "../../status-model";

import { AddCollectionDialog } from "../components/AddCollectionDialog";
import { AIModelSelector } from "../components/AIModelSelector";
import { BootstrapStatus } from "../components/BootstrapStatus";
import { CaptureButton } from "../components/CaptureButton";
import { FirstRunWizard } from "../components/FirstRunWizard";
import { GnoLogo } from "../components/GnoLogo";
import { HealthCenter } from "../components/HealthCenter";
import { IndexingProgress } from "../components/IndexingProgress";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "../components/ui/card";
import { Progress } from "../components/ui/progress";
import { apiFetch } from "../hooks/use-api";
import { useCaptureModal } from "../hooks/useCaptureModal";
import {
  loadFavoriteCollections,
  loadFavoriteDocuments,
  loadRecentDocuments,
  toggleFavoriteCollection,
  type FavoriteCollection,
  type FavoriteDoc,
  type RecentDoc,
} from "../lib/navigation-state";

interface SyncResponse {
  jobId: string;
}

interface EmbedResponse {
  embedded?: number;
  errors?: number;
  running?: boolean;
  pendingCount?: number;
  note?: string;
}

interface SyncResultSummary {
  collections: Array<{
    collection: string;
    filesProcessed: number;
    filesAdded: number;
    filesUpdated: number;
    filesUnchanged: number;
    filesErrored: number;
    durationMs: number;
  }>;
  totalDurationMs: number;
  totalFilesProcessed: number;
  totalFilesAdded: number;
  totalFilesUpdated: number;
  totalFilesErrored: number;
  totalFilesSkipped: number;
}

interface DownloadProgressState {
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
}

interface ModelDownloadStatus {
  active: boolean;
  currentType: string | null;
  progress: DownloadProgressState | null;
  completed: string[];
  failed: Array<{ type: string; error: string }>;
  startedAt: number | null;
}

interface PageProps {
  navigate: (to: string | number) => void;
}

export default function Dashboard({ navigate }: PageProps) {
  const [status, setStatus] = useState<AppStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [initialCollectionPath, setInitialCollectionPath] = useState<
    string | undefined
  >(undefined);
  const [busyAction, setBusyAction] = useState<HealthActionKind | null>(null);
  const [recentDocs, setRecentDocs] = useState<RecentDoc[]>([]);
  const [favoriteDocs, setFavoriteDocs] = useState<FavoriteDoc[]>([]);
  const [favoriteCollections, setFavoriteCollections] = useState<
    FavoriteCollection[]
  >([]);
  const [modelDownloadStatus, setModelDownloadStatus] =
    useState<ModelDownloadStatus | null>(null);
  const { openCapture } = useCaptureModal();

  const openCollections = () => navigate("/collections");

  const loadStatus = useCallback(async () => {
    const { data, error: err } =
      await apiFetch<AppStatusResponse>("/api/status");
    if (err) {
      setError(err);
      return;
    }

    setStatus(data);
    setError(null);
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    setRecentDocs(loadRecentDocuments());
    setFavoriteDocs(loadFavoriteDocuments());
    setFavoriteCollections(loadFavoriteCollections());
  }, []);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    async function pollModelStatus(): Promise<void> {
      const { data } =
        await apiFetch<ModelDownloadStatus>("/api/models/status");
      if (cancelled || !data) {
        return;
      }

      setModelDownloadStatus(data);

      if (!data.active && intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        void loadStatus();
      }
    }

    void pollModelStatus();

    if (
      busyAction === "download-models" ||
      status?.bootstrap.models.downloading ||
      modelDownloadStatus?.active
    ) {
      intervalId = setInterval(() => {
        void pollModelStatus();
      }, 1000);
    }

    return () => {
      cancelled = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [
    busyAction,
    loadStatus,
    modelDownloadStatus?.active,
    status?.bootstrap.models.downloading,
  ]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncJobId(null);

    const { data, error: err } = await apiFetch<SyncResponse>("/api/sync", {
      method: "POST",
    });

    if (err) {
      setSyncing(false);
      setError(err);
      return;
    }

    if (data?.jobId) {
      setSyncJobId(data.jobId);
    }
  }, []);

  const handleSyncComplete = (result?: SyncResultSummary) => {
    setSyncing(false);
    void loadStatus();

    const isNoop =
      !!result &&
      result.totalFilesProcessed === 0 &&
      result.totalFilesAdded === 0 &&
      result.totalFilesUpdated === 0 &&
      result.totalFilesErrored === 0;

    window.setTimeout(
      () => {
        setSyncJobId(null);
      },
      isNoop ? 2500 : 1200
    );
  };

  const handleOpenAddCollection = (path?: string) => {
    setInitialCollectionPath(path);
    setAddDialogOpen(true);
  };

  const handleDownloadModels = useCallback(async () => {
    setBusyAction("download-models");
    const { error: err } = await apiFetch("/api/models/pull", {
      method: "POST",
    });
    setBusyAction(null);

    if (err) {
      setError(err);
      return;
    }

    const { data } = await apiFetch<ModelDownloadStatus>("/api/models/status");
    if (data) {
      setModelDownloadStatus(data);
    }
    void loadStatus();
  }, [loadStatus]);

  const handleEmbedNow = useCallback(async () => {
    setBusyAction("embed");
    const { data, error: err } = await apiFetch<EmbedResponse>("/api/embed", {
      method: "POST",
    });
    setBusyAction(null);

    if (err) {
      setError(err);
      return;
    }

    if (data?.errors && data.errors > 0) {
      setError(`Embedding failed for ${data.errors} chunks.`);
    }

    void loadStatus();
  }, [loadStatus]);

  const isModelDownloadBlocking =
    busyAction === "download-models" || modelDownloadStatus?.active;

  const handleHealthAction = (action: HealthActionKind) => {
    if (action === "add-collection") {
      handleOpenAddCollection();
      return;
    }

    if (action === "open-collections") {
      openCollections();
      return;
    }

    if (action === "sync") {
      void handleSync();
      return;
    }

    if (action === "embed") {
      void handleEmbedNow();
      return;
    }

    if (action === "download-models") {
      void handleDownloadModels();
    }
  };

  const handleToggleFavoriteCollection = (
    collection: AppStatusResponse["collections"][number]
  ) => {
    setFavoriteCollections(
      toggleFavoriteCollection({
        name: collection.name,
        href: `/browse?collection=${encodeURIComponent(collection.name)}`,
        label: collection.name,
      })
    );
  };

  return (
    <div className="min-h-screen">
      {isModelDownloadBlocking && (
        <div className="fixed inset-0 z-[90] bg-background/85 backdrop-blur-sm">
          <div className="flex min-h-screen items-center justify-center px-6">
            <Card className="w-full max-w-2xl border-primary/30 bg-card/95 shadow-2xl">
              <CardHeader className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="flex size-11 items-center justify-center rounded-full bg-primary/12 text-primary">
                    <DownloadIcon className="size-5" />
                  </div>
                  <div>
                    <div className="font-semibold text-xl">
                      Downloading local models
                    </div>
                    <CardDescription className="mt-1 text-sm">
                      GNO is preparing the active preset. Keep this page open
                      until the download finishes.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="font-medium text-sm">
                      {modelDownloadStatus?.currentType
                        ? `Current step: ${modelDownloadStatus.currentType}`
                        : "Preparing download"}
                    </span>
                    <span className="font-mono text-muted-foreground text-xs">
                      {modelDownloadStatus?.progress
                        ? `${modelDownloadStatus.progress.percent.toFixed(0)}%`
                        : "Starting..."}
                    </span>
                  </div>
                  <Progress
                    value={modelDownloadStatus?.progress?.percent ?? 5}
                  />
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                    <div className="mb-2 font-medium text-sm">Completed</div>
                    <p className="text-muted-foreground text-sm">
                      {modelDownloadStatus?.completed.length
                        ? modelDownloadStatus.completed.join(", ")
                        : "Nothing completed yet."}
                    </p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-background/70 p-4">
                    <div className="mb-2 font-medium text-sm">
                      Why this blocks
                    </div>
                    <p className="text-muted-foreground text-sm">
                      Search can partially work while files stream in, but
                      results and first-run status are clearer once the preset
                      download finishes.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      <header className="relative border-border/50 border-b bg-card/50 backdrop-blur-sm">
        <div className="aurora-glow absolute inset-0 opacity-30" />
        <div className="relative px-8 py-12">
          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <GnoLogo className="size-8 shrink-0 text-primary" />
                <h1 className="font-bold text-4xl text-primary tracking-tight">
                  GNO
                </h1>
              </div>
              <p className="mt-4 text-lg text-muted-foreground">
                Your Local Knowledge Index
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 md:justify-end">
              <AIModelSelector showLabel={false} />
              <Button
                disabled={syncing}
                onClick={() => void handleSync()}
                size="sm"
                variant="outline"
              >
                {syncing ? (
                  <Loader2Icon className="mr-1.5 size-4 animate-spin" />
                ) : (
                  <RefreshCwIcon className="mr-1.5 size-4" />
                )}
                {syncing ? "Syncing..." : "Update All"}
              </Button>
            </div>
          </div>

          {syncJobId && (!status || status.onboarding.ready) && (
            <div className="mt-4 rounded-lg border border-border/50 bg-background/50 p-4">
              <IndexingProgress
                jobId={syncJobId}
                onComplete={handleSyncComplete}
                onError={() => {
                  setSyncing(false);
                  setSyncJobId(null);
                }}
              />
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-8">
        {status && !status.onboarding.ready && (
          <section className="mb-10">
            <FirstRunWizard
              onboarding={status.onboarding}
              onAddCollection={handleOpenAddCollection}
              onDownloadModels={() => void handleDownloadModels()}
              onEmbed={() => void handleEmbedNow()}
              onSync={() => void handleSync()}
              onSyncComplete={handleSyncComplete}
              embedding={busyAction === "embed"}
              syncJobId={syncJobId}
              syncing={syncing}
            />
          </section>
        )}

        <nav className="mb-10 flex flex-wrap gap-4">
          <Button
            className="gap-2"
            onClick={() => navigate("/search")}
            size="lg"
          >
            <Search className="size-4" />
            Search
          </Button>
          <Button
            className="gap-2"
            onClick={() => navigate("/ask")}
            size="lg"
            variant="secondary"
          >
            <MessageSquare className="size-4" />
            Ask
          </Button>
          <Button
            className="gap-2"
            onClick={() => navigate("/browse")}
            size="lg"
            variant="outline"
          >
            <BookOpen className="size-4" />
            Browse
          </Button>
          <Button
            className="gap-2"
            onClick={openCollections}
            size="lg"
            variant="outline"
          >
            <FolderIcon className="size-4" />
            Collections
          </Button>
          <Button
            className="gap-2"
            onClick={() => navigate("/connectors")}
            size="lg"
            variant="outline"
          >
            <CpuIcon className="size-4" />
            Connectors
          </Button>
          <Button
            className="gap-2"
            onClick={() => navigate("/graph")}
            size="lg"
            variant="outline"
          >
            <GitForkIcon className="size-4" />
            Graph
          </Button>
        </nav>

        {error && (
          <Card className="mb-6 border-destructive bg-destructive/10">
            <CardContent className="py-4 text-destructive">{error}</CardContent>
          </Card>
        )}

        {status && (
          <div className="mb-10">
            <HealthCenter
              busyAction={busyAction}
              health={status.health}
              onAction={handleHealthAction}
            />
          </div>
        )}

        {status && (
          <div className="mb-10">
            <BootstrapStatus
              bootstrap={status.bootstrap}
              onDownloadModels={() => void handleDownloadModels()}
            />
          </div>
        )}

        {(recentDocs.length > 0 ||
          favoriteDocs.length > 0 ||
          favoriteCollections.length > 0) && (
          <section className="mb-10 grid gap-4 xl:grid-cols-3">
            <Card className="border-border/60 bg-card/70">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <StarIcon className="size-4 text-primary" />
                  <CardDescription>Favorite Documents</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {favoriteDocs.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Favorite a document from Browse to keep it here.
                  </p>
                ) : (
                  favoriteDocs.slice(0, 5).map((doc) => (
                    <Button
                      className="w-full justify-start"
                      key={doc.href}
                      onClick={() => navigate(doc.href)}
                      variant="ghost"
                    >
                      {doc.label}
                    </Button>
                  ))
                )}
              </CardContent>
            </Card>
            <Card className="border-border/60 bg-card/70">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <FolderHeartIcon className="size-4 text-primary" />
                  <CardDescription>Pinned Collections</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {favoriteCollections.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Pin collections from the dashboard cards.
                  </p>
                ) : (
                  favoriteCollections.slice(0, 5).map((collection) => (
                    <Button
                      className="w-full justify-start"
                      key={collection.name}
                      onClick={() => navigate(collection.href)}
                      variant="ghost"
                    >
                      {collection.label}
                    </Button>
                  ))
                )}
              </CardContent>
            </Card>
            <Card className="border-border/60 bg-card/70">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Search className="size-4 text-primary" />
                  <CardDescription>Recent Documents</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {recentDocs.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Open a few notes and they will show up here.
                  </p>
                ) : (
                  recentDocs.slice(0, 5).map((doc) => (
                    <Button
                      className="w-full justify-start"
                      key={doc.href}
                      onClick={() => navigate(doc.href)}
                      variant="ghost"
                    >
                      {doc.label}
                    </Button>
                  ))
                )}
              </CardContent>
            </Card>
          </section>
        )}

        {status && (
          <div className="mb-10 grid animate-fade-in gap-6 opacity-0 md:grid-cols-4">
            <Card className="group relative overflow-hidden border-primary/30 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent transition-all duration-300 hover:border-primary/50 hover:shadow-[0_0_30px_-10px_hsl(var(--primary)/0.3)]">
              <div className="pointer-events-none absolute -top-12 -right-12 size-32 rounded-full bg-primary/10 blur-2xl" />
              <CardHeader className="relative pb-2">
                <CardDescription className="flex items-center gap-2 text-primary/80">
                  <Database className="size-4" />
                  Documents
                </CardDescription>
              </CardHeader>
              <CardContent className="relative">
                <div className="font-bold text-5xl tracking-tight text-primary">
                  {status.totalDocuments.toLocaleString()}
                </div>
                <p className="mt-1 text-muted-foreground text-sm">
                  indexed files
                </p>
              </CardContent>
            </Card>

            <Card className="group stagger-1 animate-fade-in opacity-0 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <Layers className="size-4" />
                  Chunks
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="font-bold text-4xl tracking-tight">
                  {status.totalChunks.toLocaleString()}
                </div>
              </CardContent>
            </Card>

            <Card
              className="group stagger-2 animate-fade-in cursor-pointer opacity-0 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-lg"
              onClick={openCollections}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openCollections();
                }
              }}
              role="button"
              tabIndex={0}
            >
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <FolderIcon className="size-4" />
                  Collections
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-4xl tracking-tight">
                    {status.collections.length}
                  </span>
                  {status.healthy && (
                    <CheckCircle2Icon className="size-5 text-green-500" />
                  )}
                </div>
                <p className="mt-2 text-muted-foreground text-sm">
                  Add folders, re-index after changes, remove old sources.
                </p>
              </CardContent>
            </Card>

            <Card
              className="group stagger-3 animate-fade-in cursor-pointer opacity-0 transition-all duration-200 hover:-translate-y-0.5 hover:border-secondary/50 hover:bg-secondary/5 hover:shadow-lg"
              onClick={() => openCapture()}
            >
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <PenIcon className="size-4" />
                  Quick Capture
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <span className="font-medium text-lg transition-colors group-hover:text-secondary">
                    New Note
                  </span>
                  <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded border border-border/80 bg-gradient-to-b from-muted/80 to-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground shadow-[0_2px_0_hsl(var(--border)),inset_0_1px_0_hsl(var(--background)/0.5)] transition-colors group-hover:border-secondary/50 group-hover:text-secondary">
                    N
                  </kbd>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {status && status.collections.length > 0 && (
          <section className="stagger-3 animate-fade-in opacity-0">
            <div className="mb-6 flex items-center justify-between gap-4 border-border/50 border-b pb-3">
              <h2 className="font-semibold text-2xl">Collections</h2>
              <Button onClick={openCollections} size="sm" variant="outline">
                Manage Collections
              </Button>
            </div>
            <div className="space-y-3">
              {status.collections.map((collection, index) => (
                <Card
                  className="group animate-fade-in cursor-pointer opacity-0 transition-all hover:border-primary/50 hover:bg-card/80"
                  key={collection.name}
                  onClick={() =>
                    navigate(
                      `/browse?collection=${encodeURIComponent(collection.name)}`
                    )
                  }
                  style={{ animationDelay: `${0.4 + index * 0.1}s` }}
                >
                  <CardContent className="flex items-center justify-between py-4">
                    <div className="flex items-center gap-3">
                      {syncing ? (
                        <Loader2Icon className="size-4 animate-spin text-amber-500" />
                      ) : collection.embeddedCount >= collection.chunkCount ? (
                        <CheckCircle2Icon className="size-4 text-green-500" />
                      ) : (
                        <div className="size-4 rounded-full border-2 border-amber-500" />
                      )}
                      <div>
                        <div className="font-medium text-lg transition-colors group-hover:text-primary">
                          {collection.name}
                        </div>
                        <div className="font-mono text-muted-foreground text-sm">
                          {collection.path}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-right">
                      <Button
                        onClick={(event) => {
                          event.stopPropagation();
                          handleToggleFavoriteCollection(collection);
                        }}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <StarIcon
                          className={`size-4 ${
                            favoriteCollections.some(
                              (entry) => entry.name === collection.name
                            )
                              ? "fill-current text-secondary"
                              : "text-muted-foreground"
                          }`}
                        />
                      </Button>
                      <div className="font-medium">
                        {collection.documentCount.toLocaleString()} docs
                      </div>
                      <div className="text-muted-foreground text-sm">
                        {collection.embeddedCount === collection.chunkCount
                          ? `${collection.chunkCount.toLocaleString()} chunks`
                          : `${collection.embeddedCount}/${collection.chunkCount} embedded`}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )}
      </main>

      <CaptureButton onClick={() => openCapture()} />
      <AddCollectionDialog
        initialPath={initialCollectionPath}
        onOpenChange={setAddDialogOpen}
        onSuccess={() => void loadStatus()}
        open={addDialogOpen}
      />
    </div>
  );
}
