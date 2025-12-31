import {
  BookOpen,
  Database,
  Layers,
  MessageSquare,
  Search,
  Sparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { PresetSelector } from '../components/preset-selector';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from '../components/ui/card';
import { apiFetch } from '../hooks/use-api';

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

  useEffect(() => {
    apiFetch<StatusData>('/api/status').then(({ data, error }) => {
      if (error) {
        setError(error);
      } else {
        setStatus(data);
      }
    });
  }, []);

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
            <PresetSelector />
          </div>
          <p className="text-lg text-muted-foreground">
            Your Local Knowledge Index
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-8">
        {/* Navigation */}
        <nav className="mb-10 flex gap-4">
          <Button
            className="gap-2"
            onClick={() => navigate('/search')}
            size="lg"
          >
            <Search className="size-4" />
            Search
          </Button>
          <Button
            className="gap-2"
            onClick={() => navigate('/ask')}
            size="lg"
            variant="secondary"
          >
            <MessageSquare className="size-4" />
            Ask
          </Button>
          <Button
            className="gap-2"
            onClick={() => navigate('/browse')}
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
          <div className="mb-10 grid animate-fade-in gap-6 opacity-0 md:grid-cols-3">
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
                <CardDescription>Status</CardDescription>
              </CardHeader>
              <CardContent>
                <Badge
                  className="px-3 py-1 text-lg"
                  variant={status.healthy ? 'default' : 'secondary'}
                >
                  {status.healthy ? '● Healthy' : '○ Degraded'}
                </Badge>
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
                    <div>
                      <div className="font-medium text-lg transition-colors group-hover:text-primary">
                        {c.name}
                      </div>
                      <div className="font-mono text-muted-foreground text-sm">
                        {c.path}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium">
                        {c.documentCount.toLocaleString()} docs
                      </div>
                      <div className="text-muted-foreground text-sm">
                        {c.chunkCount.toLocaleString()} chunks
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
