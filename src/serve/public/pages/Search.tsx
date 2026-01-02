import { ArrowLeft, FileText, Search as SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Loader } from "../components/ai-elements/loader";
import {
  ThoroughnessSelector,
  type Thoroughness,
} from "../components/ThoroughnessSelector";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { apiFetch } from "../hooks/use-api";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

/**
 * Render snippet with <mark> tags as highlighted spans.
 * Only allows mark tags - strips all other HTML for safety.
 */
function renderSnippet(snippet: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = snippet;
  let key = 0;

  while (remaining.length > 0) {
    const markStart = remaining.indexOf("<mark>");
    if (markStart === -1) {
      parts.push(remaining);
      break;
    }

    if (markStart > 0) {
      parts.push(remaining.slice(0, markStart));
    }

    const markEnd = remaining.indexOf("</mark>", markStart);
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
  snippetRange?: {
    startLine: number;
    endLine: number;
  };
}

interface SearchResponse {
  results: SearchResult[];
  meta: {
    query: string;
    mode: string;
    totalResults: number;
    expanded?: boolean;
    reranked?: boolean;
    vectorsUsed?: boolean;
  };
}

interface Capabilities {
  bm25: boolean;
  vector: boolean;
  hybrid: boolean;
  answer: boolean;
}

const THOROUGHNESS_ORDER: Thoroughness[] = ["fast", "balanced", "thorough"];

export default function Search({ navigate }: PageProps) {
  const [query, setQuery] = useState("");
  const [thoroughness, setThoroughness] = useState<Thoroughness>("balanced");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [meta, setMeta] = useState<SearchResponse["meta"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);

  // Fetch capabilities on mount
  useEffect(() => {
    async function fetchCapabilities() {
      const { data } = await apiFetch<Capabilities>("/api/capabilities");
      if (data) {
        setCapabilities(data);
        // Auto-select balanced if hybrid available, otherwise fast (BM25)
        if (data.hybrid) {
          setThoroughness("balanced");
        } else {
          setThoroughness("fast");
        }
      }
    }
    void fetchCapabilities();
  }, []);

  // Cycle thoroughness with 't' key
  const cycleThoroughness = useCallback(() => {
    setThoroughness((current) => {
      const currentIdx = THOROUGHNESS_ORDER.indexOf(current);
      const nextIdx = (currentIdx + 1) % THOROUGHNESS_ORDER.length;
      return THOROUGHNESS_ORDER[nextIdx];
    });
  }, []);

  const shortcuts = useMemo(
    () => [{ key: "t", action: cycleThoroughness }],
    [cycleThoroughness]
  );

  useKeyboardShortcuts(shortcuts);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) {
      return;
    }

    setLoading(true);
    setError(null);
    setSearched(true);

    // Fast uses BM25 (/api/search), balanced/thorough use hybrid (/api/query)
    const useBm25 = thoroughness === "fast";
    const endpoint = useBm25 ? "/api/search" : "/api/query";

    // Build request body
    const body: Record<string, unknown> = { query, limit: 20 };

    if (!useBm25) {
      // Map thoroughness to noExpand/noRerank flags
      // balanced: with reranking, no expansion (~2-3s)
      // thorough: full pipeline (~5-8s)
      if (thoroughness === "balanced") {
        body.noExpand = true;
        body.noRerank = false;
      } else {
        // thorough
        body.noExpand = false;
        body.noRerank = false;
      }
    }

    const { data, error } = await apiFetch<SearchResponse>(endpoint, {
      method: "POST",
      body: JSON.stringify(body),
    });

    setLoading(false);
    if (error) {
      setError(error);
      setResults([]);
      setMeta(null);
    } else if (data) {
      setResults(data.results);
      setMeta(data.meta);
    }
  };

  const hybridAvailable = capabilities?.hybrid ?? false;

  // Description for current thoroughness
  const thoroughnessDesc =
    thoroughness === "fast"
      ? "Keyword search (BM25)"
      : thoroughness === "balanced"
        ? "Hybrid + reranking"
        : "Full pipeline with expansion";

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
          <div className="group relative">
            {/* Gradient border effect on focus */}
            <div className="pointer-events-none absolute -inset-[1px] rounded-lg bg-gradient-to-r from-primary/50 via-primary to-primary/50 opacity-0 blur-sm transition-opacity duration-300 group-focus-within:opacity-100" />
            <div className="relative">
              <SearchIcon className="absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground transition-colors duration-200 group-focus-within:text-primary" />
              <Input
                autoFocus
                className="border-border/50 bg-card py-6 pr-4 pl-12 text-lg transition-all duration-200 focus:border-primary focus:bg-card/80 focus:shadow-[0_0_20px_-5px_hsl(var(--primary)/0.3)]"
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
                {loading ? <Loader size={16} /> : "Search"}
              </Button>
            </div>
          </div>

          {/* Thoroughness selector */}
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <ThoroughnessSelector
              disabled={
                loading || (!hybridAvailable && thoroughness !== "fast")
              }
              onChange={setThoroughness}
              value={thoroughness}
            />

            <span className="text-muted-foreground/70 text-xs">
              {thoroughnessDesc}
            </span>

            {!hybridAvailable && thoroughness !== "fast" && (
              <span className="text-amber-500/70 text-xs">
                (vectors not available)
              </span>
            )}
          </div>
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
            <div className="relative mx-auto mb-6 size-20">
              <div className="absolute inset-0 animate-pulse rounded-full bg-primary/10" />
              <div className="absolute inset-2 rounded-full bg-card" />
              <FileText className="absolute inset-0 m-auto size-8 text-muted-foreground" />
            </div>
            <h3 className="mb-2 font-semibold text-xl">No matches found</h3>
            <p className="mx-auto mb-6 max-w-sm text-muted-foreground">
              We couldn't find any documents matching "{query}". Try different
              keywords or check your spelling.
            </p>
            <div className="flex justify-center gap-3">
              <Button onClick={() => setQuery("")} size="sm" variant="outline">
                Clear search
              </Button>
              <Button onClick={cycleThoroughness} size="sm" variant="ghost">
                Try different mode
              </Button>
            </div>
          </div>
        )}

        {/* Results */}
        {!loading && results.length > 0 && (
          <div className="space-y-4">
            <div className="mb-6 flex items-center justify-between">
              <p className="text-muted-foreground text-sm">
                {results.length} result{results.length !== 1 ? "s" : ""}
              </p>
              {meta && (
                <div className="flex items-center gap-2">
                  {meta.vectorsUsed && (
                    <Badge
                      className="font-mono text-[10px]"
                      variant="secondary"
                    >
                      vectors
                    </Badge>
                  )}
                  {meta.expanded && (
                    <Badge
                      className="font-mono text-[10px]"
                      variant="secondary"
                    >
                      expanded
                    </Badge>
                  )}
                  {meta.reranked && (
                    <Badge
                      className="font-mono text-[10px]"
                      variant="secondary"
                    >
                      reranked
                    </Badge>
                  )}
                </div>
              )}
            </div>
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
                      {r.title || r.uri.split("/").pop()}
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
                  <div className="mt-2 flex items-center gap-2">
                    <p className="truncate font-mono text-muted-foreground/60 text-xs">
                      {r.uri}
                    </p>
                    {r.snippetRange && (
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/40">
                        L{r.snippetRange.startLine}-{r.snippetRange.endLine}
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
