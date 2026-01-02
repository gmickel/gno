import {
  BookOpen,
  CheckCircle2Icon,
  Database,
  FolderIcon,
  Layers,
  Loader2Icon,
  MessageSquare,
  PenIcon,
  RefreshCwIcon,
  Search,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { CaptureButton } from "../components/CaptureButton";
import { IndexingProgress } from "../components/IndexingProgress";
import { PresetSelector } from "../components/preset-selector";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "../components/ui/card";
import { apiFetch } from "../hooks/use-api";
import { useCaptureModal } from "../hooks/useCaptureModal";
import { modKey } from "../hooks/useKeyboardShortcuts";

interface SyncResponse {
  jobId: string;
}

interface PageProps {
  navigate: (to: string | number) => void;
}

interface StatusData {
  indexName: string;
  totalDocuments: number;
  totalChunks: number;
  embeddingBacklog: number;
  healthy: boolean;
  collections: Array<{
    name: string;
    path: string;
    documentCount: number;
    chunkCount: number;
    embeddedCount: number;
  }>;
}

export default function Dashboard({ navigate }: PageProps) {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const { openCapture } = useCaptureModal();

  const loadStatus = useCallback(async () => {
    const { data, error: err } = await apiFetch<StatusData>("/api/status");
    if (err) {
      setError(err);
    } else {
      setStatus(data);
      setError(null);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleSync = async () => {
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
  };

  const handleSyncComplete = () => {
    setSyncing(false);
    setSyncJobId(null);
    void loadStatus();
  };

  return (
    <div className="min-h-screen">
      {/* Header with aurora glow */}
      <header className="relative border-border/50 border-b bg-card/50 backdrop-blur-sm">
        <div className="aurora-glow absolute inset-0 opacity-30" />
        <div className="relative px-8 py-12">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Sparkles className="size-8 text-primary" />
              <h1 className="font-bold text-4xl text-primary tracking-tight">
                GNO
              </h1>
            </div>
            <div className="flex items-center gap-3">
              <Button
                disabled={syncing}
                onClick={handleSync}
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
              <PresetSelector />
            </div>
          </div>
          <p className="text-lg text-muted-foreground">
            Your Local Knowledge Index
          </p>

          {/* Sync progress */}
          {syncJobId && (
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
        {/* Navigation */}
        <nav className="mb-10 flex gap-4">
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
        </nav>

        {/* Error state */}
        {error && (
          <Card className="mb-6 border-destructive bg-destructive/10">
            <CardContent className="py-4 text-destructive">{error}</CardContent>
          </Card>
        )}

        {/* Stats Grid */}
        {status && (
          <div className="mb-10 grid animate-fade-in gap-6 opacity-0 md:grid-cols-4">
            <Card className="group transition-colors hover:border-primary/50">
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <Database className="size-4" />
                  Documents
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="font-bold text-4xl tracking-tight">
                  {status.totalDocuments.toLocaleString()}
                </div>
              </CardContent>
            </Card>

            <Card className="group stagger-1 animate-fade-in opacity-0 transition-colors hover:border-primary/50">
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

            <Card className="group stagger-2 animate-fade-in opacity-0 transition-colors hover:border-primary/50">
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
              </CardContent>
            </Card>

            {/* Quick Capture Card */}
            <Card
              className="group stagger-3 animate-fade-in cursor-pointer opacity-0 transition-all hover:border-primary/50 hover:bg-primary/5"
              onClick={openCapture}
            >
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-2">
                  <PenIcon className="size-4" />
                  Quick Capture
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <span className="font-medium text-lg transition-colors group-hover:text-primary">
                    New Note
                  </span>
                  <Badge className="font-mono text-xs" variant="outline">
                    {modKey}N
                  </Badge>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Collections */}
        {status && status.collections.length > 0 && (
          <section className="stagger-3 animate-fade-in opacity-0">
            <h2 className="mb-6 border-border/50 border-b pb-3 font-semibold text-2xl">
              Collections
            </h2>
            <div className="space-y-3">
              {status.collections.map((c, i) => (
                <Card
                  className="group animate-fade-in cursor-pointer opacity-0 transition-all hover:border-primary/50 hover:bg-card/80"
                  key={c.name}
                  onClick={() =>
                    navigate(`/browse?collection=${encodeURIComponent(c.name)}`)
                  }
                  style={{ animationDelay: `${0.4 + i * 0.1}s` }}
                >
                  <CardContent className="flex items-center justify-between py-4">
                    <div className="flex items-center gap-3">
                      {/* Health indicator */}
                      {syncing ? (
                        <Loader2Icon className="size-4 animate-spin text-amber-500" />
                      ) : c.embeddedCount >= c.chunkCount ? (
                        <CheckCircle2Icon className="size-4 text-green-500" />
                      ) : (
                        <div className="size-4 rounded-full border-2 border-amber-500" />
                      )}
                      <div>
                        <div className="font-medium text-lg transition-colors group-hover:text-primary">
                          {c.name}
                        </div>
                        <div className="font-mono text-muted-foreground text-sm">
                          {c.path}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium">
                        {c.documentCount.toLocaleString()} docs
                      </div>
                      <div className="text-muted-foreground text-sm">
                        {c.embeddedCount === c.chunkCount
                          ? `${c.chunkCount.toLocaleString()} chunks`
                          : `${c.embeddedCount}/${c.chunkCount} embedded`}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Floating Action Button */}
      <CaptureButton onClick={openCapture} />
    </div>
  );
}
