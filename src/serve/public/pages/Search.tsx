import { useState } from 'react';
import { apiFetch } from '../hooks/use-api';

interface PageProps {
  navigate: (to: string) => void;
}

interface SearchResult {
  docid: string;
  uri: string;
  title?: string;
  snippet: string;
  score: number;
}

interface SearchResponse {
  results: SearchResult[];
  meta: {
    query: string;
    mode: string;
    totalResults: number;
  };
}

export default function Search({ navigate }: PageProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError(null);

    // Only BM25 search supported in web UI
    const { data, error } = await apiFetch<SearchResponse>('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit: 10 }),
    });

    setLoading(false);
    if (error) {
      setError(error);
      setResults([]);
    } else if (data) {
      setResults(data.results);
    }
  };

  return (
    <div className="min-h-screen p-8">
      <header className="mb-8 flex items-center gap-4">
        <button
          className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
          onClick={() => navigate('/')}
        >
          &larr; Back
        </button>
        <h1 className="font-semibold text-2xl">Search</h1>
      </header>

      <form className="mb-8" onSubmit={handleSearch}>
        <div className="mb-4 flex gap-4">
          <input
            className="flex-1 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your documents..."
            type="text"
            value={query}
          />
          <button
            className="rounded-lg bg-[hsl(var(--primary))] px-6 py-3 text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50"
            disabled={loading}
            type="submit"
          >
            {loading ? 'Searching...' : 'Search'}
          </button>
        </div>
        <div className="text-[hsl(var(--muted-foreground))] text-sm">
          BM25 keyword search
        </div>
      </form>

      {error && (
        <div className="mb-4 rounded-md bg-[hsl(var(--destructive))] p-4 text-[hsl(var(--destructive-foreground))]">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {results.map((r) => (
          <div
            className="cursor-pointer rounded-lg bg-[hsl(var(--card))] p-4 hover:ring-1 hover:ring-[hsl(var(--ring))]"
            key={r.docid}
            onClick={() => navigate(`/doc?uri=${encodeURIComponent(r.uri)}`)}
          >
            <div className="mb-2 flex items-start justify-between">
              <div className="font-medium text-[hsl(var(--primary))]">
                {r.title || r.uri}
              </div>
              <div className="text-[hsl(var(--muted-foreground))] text-sm">
                {(r.score * 100).toFixed(1)}%
              </div>
            </div>
            <div className="line-clamp-3 text-[hsl(var(--muted-foreground))] text-sm">
              {r.snippet}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
