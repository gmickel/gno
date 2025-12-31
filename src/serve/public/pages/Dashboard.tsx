import { useEffect, useState } from 'react';
import { apiFetch } from '../hooks/use-api';

interface PageProps {
  navigate: (to: string) => void;
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
      if (error) setError(error);
      else setStatus(data);
    });
  }, []);

  return (
    <div className="min-h-screen p-8">
      <header className="mb-8">
        <h1 className="font-semibold text-3xl text-[hsl(var(--primary))]">
          GNO
        </h1>
        <p className="text-[hsl(var(--muted-foreground))]">
          Local Knowledge Index
        </p>
      </header>

      <nav className="mb-8 flex gap-4">
        <button
          className="rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-[hsl(var(--primary-foreground))] hover:opacity-90"
          onClick={() => navigate('/search')}
        >
          Search
        </button>
        <button
          className="rounded-md bg-[hsl(var(--muted))] px-4 py-2 text-[hsl(var(--foreground))] hover:opacity-90"
          onClick={() => navigate('/browse')}
        >
          Browse
        </button>
      </nav>

      {error && (
        <div className="mb-4 rounded-md bg-[hsl(var(--destructive))] p-4 text-[hsl(var(--destructive-foreground))]">
          {error}
        </div>
      )}

      {status && (
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-lg bg-[hsl(var(--card))] p-6">
            <div className="text-[hsl(var(--muted-foreground))] text-sm">
              Documents
            </div>
            <div className="font-semibold text-3xl">
              {status.totalDocuments}
            </div>
          </div>
          <div className="rounded-lg bg-[hsl(var(--card))] p-6">
            <div className="text-[hsl(var(--muted-foreground))] text-sm">
              Chunks
            </div>
            <div className="font-semibold text-3xl">{status.totalChunks}</div>
          </div>
          <div className="rounded-lg bg-[hsl(var(--card))] p-6">
            <div className="text-[hsl(var(--muted-foreground))] text-sm">
              Status
            </div>
            <div
              className={`font-semibold text-3xl ${status.healthy ? 'text-green-500' : 'text-yellow-500'}`}
            >
              {status.healthy ? 'Healthy' : 'Degraded'}
            </div>
          </div>
        </div>
      )}

      {status && status.collections.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-4 font-semibold text-xl">Collections</h2>
          <div className="space-y-2">
            {status.collections.map((c) => (
              <div
                className="flex items-center justify-between rounded-lg bg-[hsl(var(--card))] p-4"
                key={c.name}
              >
                <div>
                  <div className="font-medium">{c.name}</div>
                  <div className="text-[hsl(var(--muted-foreground))] text-sm">
                    {c.path}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm">{c.documentCount} docs</div>
                  <div className="text-[hsl(var(--muted-foreground))] text-sm">
                    {c.chunkCount} chunks
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
