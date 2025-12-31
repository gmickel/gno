import { ArrowLeft, FileText, Search as SearchIcon } from 'lucide-react';
import { useState } from 'react';
import { Loader } from '../components/ai-elements/loader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { apiFetch } from '../hooks/use-api';

/**
 * Render snippet with <mark> tags as highlighted spans.
 * Only allows mark tags - strips all other HTML for safety.
 */
function renderSnippet(snippet: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = snippet;
  let key = 0;

  while (remaining.length > 0) {
    const markStart = remaining.indexOf('<mark>');
    if (markStart === -1) {
      parts.push(remaining);
      break;
    }

    if (markStart > 0) {
      parts.push(remaining.slice(0, markStart));
    }

    const markEnd = remaining.indexOf('</mark>', markStart);
    if (markEnd === -1) {
      parts.push(remaining.slice(markStart));
      break;
    }

    const highlighted = remaining.slice(markStart + 6, markEnd);
    parts.push(
      <mark
        className="rounded bg-primary/20 px-0.5 font-medium text-primary"
        key={key++}
      >
        {highlighted}
      </mark>
    );
    remaining = remaining.slice(markEnd + 7);
  }

  return parts;
}

interface PageProps {
  navigate: (to: string | number) => void;
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
  const [searched, setSearched] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError(null);
    setSearched(true);

    const { data, error } = await apiFetch<SearchResponse>('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit: 20 }),
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
    <div className="min-h-screen">
      {/* Header */}
      <header className="glass sticky top-0 z-10 border-border/50 border-b">
        <div className="flex items-center gap-4 px-8 py-4">
          <Button
            className="gap-2"
            onClick={() => navigate(-1)}
            size="sm"
            variant="ghost"
          >
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <h1 className="font-semibold text-xl">Search</h1>
        </div>
      </header>

      <main className="mx-auto max-w-4xl p-8">
        {/* Search Form */}
        <form className="mb-8" onSubmit={handleSearch}>
          <div className="relative">
            <SearchIcon className="absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="border-border bg-card py-6 pr-4 pl-12 text-lg focus:border-primary"
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your documents..."
              type="text"
              value={query}
            />
            <Button
              className="absolute top-1/2 right-2 -translate-y-1/2"
              disabled={loading || !query.trim()}
              size="sm"
              type="submit"
            >
              {loading ? <Loader size={16} /> : 'Search'}
            </Button>
          </div>
          <p className="mt-3 flex items-center gap-2 text-muted-foreground text-sm">
            <Badge className="font-mono text-xs" variant="outline">
              BM25
            </Badge>
            Full-text keyword search
          </p>
        </form>

        {/* Error */}
        {error && (
          <Card className="mb-6 border-destructive bg-destructive/10">
            <CardContent className="py-4 text-destructive">{error}</CardContent>
          </Card>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <Loader className="text-primary" size={32} />
            <p className="text-muted-foreground">Searching...</p>
          </div>
        )}

        {/* Empty state */}
        {!loading && searched && results.length === 0 && !error && (
          <div className="py-20 text-center">
            <FileText className="mx-auto mb-4 size-12 text-muted-foreground" />
            <h3 className="mb-2 font-medium text-lg">No results found</h3>
            <p className="text-muted-foreground">
              Try adjusting your search terms
            </p>
          </div>
        )}

        {/* Results */}
        {!loading && results.length > 0 && (
          <div className="space-y-4">
            <p className="mb-6 text-muted-foreground text-sm">
              {results.length} result{results.length !== 1 ? 's' : ''}
            </p>
            {results.map((r, i) => (
              <Card
                className="group animate-fade-in cursor-pointer opacity-0 transition-all hover:border-primary/50 hover:bg-card/80"
                key={`${r.docid}-${i}`}
                onClick={() =>
                  navigate(`/doc?uri=${encodeURIComponent(r.uri)}`)
                }
                style={{ animationDelay: `${i * 0.05}s` }}
              >
                <CardContent className="py-4">
                  <div className="mb-2 flex items-start justify-between gap-4">
                    <h3 className="font-medium text-primary underline-offset-2 group-hover:underline">
                      {r.title || r.uri.split('/').pop()}
                    </h3>
                    <Badge
                      className="shrink-0 font-mono text-xs"
                      variant="secondary"
                    >
                      {(r.score * 100).toFixed(0)}%
                    </Badge>
                  </div>
                  <p className="line-clamp-3 text-muted-foreground text-sm leading-relaxed">
                    {renderSnippet(r.snippet)}
                  </p>
                  <p className="mt-2 truncate font-mono text-muted-foreground/60 text-xs">
                    {r.uri}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
