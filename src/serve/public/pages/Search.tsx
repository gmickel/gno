import {
  ArrowLeft,
  ChevronDown,
  FileText,
  HomeIcon,
  Search as SearchIcon,
  SlidersHorizontal,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { resolveDepthPolicy } from "../../../core/depth-policy";
import { normalizeStructuredQueryInput } from "../../../core/structured-query";
import { Loader } from "../components/ai-elements/loader";
import { AIModelSelector } from "../components/AIModelSelector";
import { TagFacets } from "../components/TagFacets";
import {
  ThoroughnessSelector,
  type Thoroughness,
} from "../components/ThoroughnessSelector";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { apiFetch } from "../hooks/use-api";
import { useDocEvents } from "../hooks/use-doc-events";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { buildDocDeepLink } from "../lib/deep-links";
import {
  applyFiltersToUrl,
  parseFiltersFromSearch,
  type QueryModeEntry,
  type QueryModeType,
  type TagMode,
} from "../lib/retrieval-filters";
import { cn } from "../lib/utils";

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
    queryModes?: {
      term: number;
      intent: number;
      hyde: boolean;
    };
  };
}

interface Capabilities {
  bm25: boolean;
  vector: boolean;
  hybrid: boolean;
  answer: boolean;
}

interface Collection {
  name: string;
}

interface PresetsResponse {
  activePreset: string;
}

const THOROUGHNESS_ORDER: Thoroughness[] = ["fast", "balanced", "thorough"];

const QUERY_MODE_LABEL: Record<QueryModeType, string> = {
  term: "Term",
  intent: "Intent",
  hyde: "HyDE",
};

export default function Search({ navigate }: PageProps) {
  const initialFilters = useMemo(
    () => parseFiltersFromSearch(window.location.search),
    []
  );

  const [query, setQuery] = useState("");
  const [thoroughness, setThoroughness] = useState<Thoroughness>("balanced");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [meta, setMeta] = useState<SearchResponse["meta"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [activePreset, setActivePreset] = useState("slim-tuned");

  const [showAdvanced, setShowAdvanced] = useState(
    Boolean(
      initialFilters.collection ||
      initialFilters.intent ||
      initialFilters.candidateLimit ||
      initialFilters.exclude ||
      initialFilters.since ||
      initialFilters.until ||
      initialFilters.category ||
      initialFilters.author ||
      initialFilters.queryModes.length > 0
    )
  );

  const [activeTags, setActiveTags] = useState<string[]>(initialFilters.tags);
  const [tagMode, setTagMode] = useState<TagMode>(initialFilters.tagMode);
  const [selectedCollection, setSelectedCollection] = useState(
    initialFilters.collection
  );
  const [intent, setIntent] = useState(initialFilters.intent);
  const [candidateLimit, setCandidateLimit] = useState(
    initialFilters.candidateLimit
  );
  const [exclude, setExclude] = useState(initialFilters.exclude);
  const [since, setSince] = useState(initialFilters.since);
  const [until, setUntil] = useState(initialFilters.until);
  const [category, setCategory] = useState(initialFilters.category);
  const [author, setAuthor] = useState(initialFilters.author);
  const [queryModes, setQueryModes] = useState<QueryModeEntry[]>(
    initialFilters.queryModes
  );
  const [queryModeDraft, setQueryModeDraft] = useState<QueryModeType>("term");
  const [queryModeText, setQueryModeText] = useState("");
  const [queryModeError, setQueryModeError] = useState<string | null>(null);
  const [showMobileTags, setShowMobileTags] = useState(false);
  const latestDocEvent = useDocEvents();

  const hybridAvailable = capabilities?.hybrid ?? false;
  const structuredQueryState = useMemo(
    () => normalizeStructuredQueryInput(query, queryModes),
    [query, queryModes]
  );
  const structuredQueryError =
    query.trim().length > 0 && !structuredQueryState.ok
      ? structuredQueryState.error.message
      : null;
  const forceHybridForModes =
    thoroughness === "fast" &&
    (queryModes.length > 0 ||
      intent.trim().length > 0 ||
      (structuredQueryState.ok &&
        structuredQueryState.value.usedStructuredQuerySyntax));

  // Sync URL as filter state changes.
  useEffect(() => {
    const url = new URL(window.location.href);
    applyFiltersToUrl(url, {
      collection: selectedCollection,
      intent,
      candidateLimit,
      exclude,
      since,
      until,
      category,
      author,
      tagMode,
      tags: activeTags,
      queryModes,
    });
    window.history.replaceState({}, "", url.toString());
  }, [
    activeTags,
    author,
    candidateLimit,
    category,
    exclude,
    intent,
    queryModes,
    selectedCollection,
    since,
    tagMode,
    until,
  ]);

  const handleTagSelect = useCallback((tag: string) => {
    setActiveTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
  }, []);

  const handleTagRemove = useCallback((tag: string) => {
    setActiveTags((prev) => prev.filter((t) => t !== tag));
  }, []);

  useEffect(() => {
    async function bootstrap(): Promise<void> {
      const [capabilitiesResult, collectionsResult, presetsResult] =
        await Promise.all([
          apiFetch<Capabilities>("/api/capabilities"),
          apiFetch<Collection[]>("/api/collections"),
          apiFetch<PresetsResponse>("/api/presets"),
        ]);

      if (capabilitiesResult.data) {
        const caps = capabilitiesResult.data;
        setCapabilities(caps);
        setThoroughness(caps.hybrid ? "balanced" : "fast");
      }

      if (collectionsResult.data) {
        setCollections(collectionsResult.data);
      }

      if (presetsResult.data?.activePreset) {
        setActivePreset(presetsResult.data.activePreset);
      }
    }

    void bootstrap();
  }, []);

  const cycleThoroughness = useCallback(() => {
    setThoroughness((current) => {
      if (!hybridAvailable) return "fast";
      const currentIdx = THOROUGHNESS_ORDER.indexOf(current);
      const nextIdx = (currentIdx + 1) % THOROUGHNESS_ORDER.length;
      return THOROUGHNESS_ORDER[nextIdx] ?? "fast";
    });
  }, [hybridAvailable]);

  const shortcuts = useMemo(
    () => [{ key: "t", action: cycleThoroughness }],
    [cycleThoroughness]
  );
  useKeyboardShortcuts(shortcuts);

  const handleAddQueryMode = useCallback(() => {
    const text = queryModeText.trim();
    if (!text) {
      return;
    }
    if (
      queryModeDraft === "hyde" &&
      queryModes.some((queryMode) => queryMode.mode === "hyde")
    ) {
      setQueryModeError("Only one HyDE mode is allowed.");
      return;
    }
    setQueryModes((prev) => [...prev, { mode: queryModeDraft, text }]);
    setQueryModeText("");
    setQueryModeError(null);
  }, [queryModeDraft, queryModeText, queryModes]);

  const handleRemoveQueryMode = useCallback((index: number) => {
    setQueryModes((prev) => prev.filter((_, i) => i !== index));
    setQueryModeError(null);
  }, []);

  const handleSearch = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!query.trim()) {
        return;
      }
      if (!structuredQueryState.ok) {
        setError(structuredQueryState.error.message);
        return;
      }

      setLoading(true);
      setError(null);
      setSearched(true);
      const depthPolicy = resolveDepthPolicy({
        presetId: activePreset,
        fast: thoroughness === "fast",
        thorough: thoroughness === "thorough",
        hasStructuredModes: queryModes.length > 0,
        candidateLimit: candidateLimit.trim()
          ? Number(candidateLimit)
          : undefined,
      });

      const useBm25 =
        thoroughness === "fast" &&
        queryModes.length === 0 &&
        intent.trim().length === 0 &&
        !structuredQueryState.value.usedStructuredQuerySyntax;
      const endpoint = useBm25 ? "/api/search" : "/api/query";
      const body: Record<string, unknown> = {
        query,
        limit: 20,
      };

      if (selectedCollection) {
        body.collection = selectedCollection;
      }
      if (intent.trim()) {
        body.intent = intent.trim();
      }
      if (depthPolicy.candidateLimit !== undefined) {
        body.candidateLimit = depthPolicy.candidateLimit;
      }
      if (exclude.trim()) {
        body.exclude = exclude.trim();
      }
      if (since) {
        body.since = since;
      }
      if (until) {
        body.until = until;
      }
      if (category.trim()) {
        body.category = category.trim();
      }
      if (author.trim()) {
        body.author = author.trim();
      }
      if (activeTags.length > 0) {
        if (tagMode === "all") {
          body.tagsAll = activeTags.join(",");
        } else {
          body.tagsAny = activeTags.join(",");
        }
      }

      if (!useBm25) {
        body.noExpand = depthPolicy.noExpand;
        body.noRerank = depthPolicy.noRerank;
        if (queryModes.length > 0) {
          body.queryModes = queryModes;
        }
      }

      const { data, error: fetchError } = await apiFetch<SearchResponse>(
        endpoint,
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );

      setLoading(false);
      if (fetchError) {
        setError(fetchError);
        setResults([]);
        setMeta(null);
      } else if (data) {
        setResults(data.results);
        setMeta(data.meta);
      }
    },
    [
      activeTags,
      author,
      candidateLimit,
      activePreset,
      category,
      exclude,
      intent,
      query,
      queryModes,
      selectedCollection,
      since,
      structuredQueryState,
      tagMode,
      thoroughness,
      until,
    ]
  );

  // Re-search when filters change after an initial search.
  useEffect(() => {
    if (searched && query.trim()) {
      void handleSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTags,
    activePreset,
    author,
    candidateLimit,
    category,
    exclude,
    intent,
    queryModes,
    selectedCollection,
    since,
    tagMode,
    until,
  ]);

  useEffect(() => {
    if (!latestDocEvent?.changedAt) {
      return;
    }
    if (searched && query.trim()) {
      void handleSearch();
    }
  }, [handleSearch, latestDocEvent?.changedAt, query, searched]);

  const thoroughnessDesc =
    thoroughness === "fast"
      ? "Keyword search (BM25)"
      : thoroughness === "balanced"
        ? resolveDepthPolicy({ presetId: activePreset })
            .balancedExpansionEnabled
          ? "Hybrid + tuned expansion"
          : "Hybrid + reranking"
        : "Expansion + reranking + wider candidate pool";

  const activeFilterPills = [
    selectedCollection ? `collection:${selectedCollection}` : null,
    intent.trim() ? `intent:${intent.trim()}` : null,
    candidateLimit.trim() ? `candidates:${candidateLimit.trim()}` : null,
    exclude.trim() ? `exclude:${exclude.trim()}` : null,
    since ? `since:${since}` : null,
    until ? `until:${until}` : null,
    category.trim() ? `category:${category.trim()}` : null,
    author.trim() ? `author:${author.trim()}` : null,
    queryModes.length > 0 ? `${queryModes.length} query mode(s)` : null,
  ].filter((pill): pill is string => Boolean(pill));

  const hasActiveFilters =
    activeFilterPills.length > 0 || activeTags.length > 0;

  const clearAdvancedFilters = () => {
    setSelectedCollection("");
    setIntent("");
    setCandidateLimit("");
    setExclude("");
    setSince("");
    setUntil("");
    setCategory("");
    setAuthor("");
    setQueryModes([]);
    setQueryModeText("");
    setQueryModeError(null);
  };

  const handleQueryKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSearch();
    }
  };

  const browseSelectedCollection = () => {
    if (!selectedCollection) {
      navigate("/browse");
      return;
    }
    navigate(`/browse?collection=${encodeURIComponent(selectedCollection)}`);
  };

  return (
    <div className="min-h-screen">
      <header className="glass sticky top-0 z-10 border-border/50 border-b">
        <div className="flex flex-wrap items-center justify-between gap-4 px-8 py-4">
          <div className="flex items-center gap-4">
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
              <ArrowLeft className="size-4" />
              Back
            </Button>
            <h1 className="font-semibold text-xl">Search</h1>
          </div>
          <AIModelSelector onPresetChange={setActivePreset} />
        </div>
      </header>

      <div className="flex">
        <aside className="sticky top-[65px] hidden h-[calc(100vh-65px)] w-64 shrink-0 overflow-y-auto border-border/30 border-r lg:block">
          <TagFacets
            activeTags={activeTags}
            className="py-4"
            onTagRemove={handleTagRemove}
            onTagSelect={handleTagSelect}
          />
        </aside>

        <main className="min-w-0 flex-1 p-8">
          <div className="mx-auto max-w-3xl">
            <form className="mb-6 space-y-4" onSubmit={handleSearch}>
              <div className="group relative">
                <div className="pointer-events-none absolute -inset-[1px] rounded-lg bg-gradient-to-r from-primary/50 via-primary to-primary/50 opacity-0 blur-sm transition-opacity duration-300 group-focus-within:opacity-100" />
                <div className="relative">
                  <SearchIcon className="absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground transition-colors duration-200 group-focus-within:text-primary" />
                  <Textarea
                    autoFocus
                    className="min-h-[72px] resize-y border-border/50 bg-card pt-5 pr-20 pb-4 pl-12 text-base transition-all duration-200 focus:border-primary focus:bg-card/80 focus:shadow-[0_0_20px_-5px_hsl(var(--primary)/0.3)]"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleQueryKeyDown}
                    placeholder="Search your documents... Use Shift+Enter for structured query documents"
                    value={query}
                  />
                  <Button
                    className="absolute top-1/2 right-2 -translate-y-1/2"
                    disabled={
                      loading || !query.trim() || Boolean(structuredQueryError)
                    }
                    size="sm"
                    type="submit"
                  >
                    {loading ? <Loader size={16} /> : "Search"}
                  </Button>
                </div>
              </div>

              {structuredQueryError && (
                <p className="text-destructive text-xs">
                  {structuredQueryError}
                </p>
              )}

              <p className="text-muted-foreground/70 text-xs">
                Press Enter to search. Use Shift+Enter for multi-line structured
                query documents with <code>term:</code>, <code>intent:</code>,
                and <code>hyde:</code>.
              </p>

              <div className="flex flex-wrap items-center gap-4">
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

                {forceHybridForModes && (
                  <span className="text-amber-500/80 text-xs">
                    query modes active: using hybrid endpoint
                  </span>
                )}

                {!hybridAvailable && thoroughness !== "fast" && (
                  <span className="text-amber-500/70 text-xs">
                    (vectors not available)
                  </span>
                )}
              </div>

              <Collapsible onOpenChange={setShowAdvanced} open={showAdvanced}>
                <CollapsibleTrigger asChild>
                  <Button
                    className="gap-2"
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <SlidersHorizontal className="size-4" />
                    Advanced Retrieval
                    <ChevronDown
                      className={cn(
                        "size-4 transition-transform",
                        showAdvanced && "rotate-180"
                      )}
                    />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3">
                  <Card className="border-border/50 bg-card/50">
                    <CardContent className="space-y-4 pt-4">
                      <div className="grid gap-3 md:grid-cols-2">
                        <div>
                          <p className="mb-1 text-muted-foreground text-xs">
                            Collection
                          </p>
                          <Select
                            onValueChange={(value) =>
                              setSelectedCollection(
                                value === "all" ? "" : value
                              )
                            }
                            value={selectedCollection || "all"}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="All collections" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="all">
                                All collections
                              </SelectItem>
                              {collections.map((collection) => (
                                <SelectItem
                                  key={collection.name}
                                  value={collection.name}
                                >
                                  {collection.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button
                              onClick={() => navigate("/collections")}
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              Manage collections
                            </Button>
                            <Button
                              onClick={browseSelectedCollection}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              {selectedCollection
                                ? "Browse selected"
                                : "Browse all"}
                            </Button>
                          </div>
                        </div>

                        <div>
                          <p className="mb-1 text-muted-foreground text-xs">
                            Author
                          </p>
                          <Input
                            onChange={(e) => setAuthor(e.target.value)}
                            placeholder="gordon"
                            value={author}
                          />
                        </div>

                        <div className="md:col-span-2">
                          <p className="mb-1 text-muted-foreground text-xs">
                            Intent
                          </p>
                          <Input
                            onChange={(e) => setIntent(e.target.value)}
                            placeholder="Disambiguate ambiguous queries without searching on this text"
                            value={intent}
                          />
                        </div>

                        <div className="md:col-span-2">
                          <p className="mb-1 text-muted-foreground text-xs">
                            Exclude
                          </p>
                          <Input
                            onChange={(e) => setExclude(e.target.value)}
                            placeholder="team reviews, hiring, onboarding"
                            value={exclude}
                          />
                        </div>

                        <div>
                          <p className="mb-1 text-muted-foreground text-xs">
                            Category
                          </p>
                          <Input
                            onChange={(e) => setCategory(e.target.value)}
                            placeholder="engineering, research"
                            value={category}
                          />
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <p className="mb-1 text-muted-foreground text-xs">
                              Since
                            </p>
                            <Input
                              onChange={(e) => setSince(e.target.value)}
                              type="date"
                              value={since}
                            />
                          </div>
                          <div>
                            <p className="mb-1 text-muted-foreground text-xs">
                              Until
                            </p>
                            <Input
                              onChange={(e) => setUntil(e.target.value)}
                              type="date"
                              value={until}
                            />
                          </div>
                        </div>

                        <div>
                          <p className="mb-1 text-muted-foreground text-xs">
                            Candidate limit
                          </p>
                          <Input
                            inputMode="numeric"
                            min="1"
                            onChange={(e) => setCandidateLimit(e.target.value)}
                            placeholder="20"
                            type="number"
                            value={candidateLimit}
                          />
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-muted-foreground text-xs">
                          Tag match:
                        </span>
                        <Button
                          onClick={() => setTagMode("any")}
                          size="sm"
                          type="button"
                          variant={tagMode === "any" ? "default" : "outline"}
                        >
                          Any
                        </Button>
                        <Button
                          onClick={() => setTagMode("all")}
                          size="sm"
                          type="button"
                          variant={tagMode === "all" ? "default" : "outline"}
                        >
                          All
                        </Button>

                        <Button
                          className="ml-auto"
                          onClick={clearAdvancedFilters}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Clear advanced
                        </Button>
                      </div>

                      <div className="space-y-2">
                        <p className="text-muted-foreground text-xs">
                          Query modes (term, intent, hyde)
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Select
                            onValueChange={(value) =>
                              setQueryModeDraft(value as QueryModeType)
                            }
                            value={queryModeDraft}
                          >
                            <SelectTrigger className="w-[120px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="term">Term</SelectItem>
                              <SelectItem value="intent">Intent</SelectItem>
                              <SelectItem value="hyde">HyDE</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input
                            className="min-w-[220px] flex-1"
                            onChange={(e) => setQueryModeText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleAddQueryMode();
                              }
                            }}
                            placeholder="Add query mode text"
                            value={queryModeText}
                          />
                          <Button
                            onClick={handleAddQueryMode}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Add mode
                          </Button>
                        </div>

                        {queryModeError && (
                          <p className="text-destructive text-xs">
                            {queryModeError}
                          </p>
                        )}

                        {queryModes.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            {queryModes.map((queryMode, index) => (
                              <button
                                className={cn(
                                  "group inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10",
                                  "px-2.5 py-1 font-mono text-[11px] text-primary transition-all duration-150",
                                  "hover:border-primary/50 hover:bg-primary/20"
                                )}
                                key={`${queryMode.mode}:${queryMode.text}:${index}`}
                                onClick={() => handleRemoveQueryMode(index)}
                                type="button"
                              >
                                <span>{`${QUERY_MODE_LABEL[queryMode.mode]}: ${queryMode.text}`}</span>
                                <XIcon className="size-3 opacity-60 transition-opacity group-hover:opacity-100" />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </CollapsibleContent>
              </Collapsible>
            </form>

            <div className="mb-6 lg:hidden">
              <Collapsible
                onOpenChange={setShowMobileTags}
                open={showMobileTags}
              >
                <CollapsibleTrigger asChild>
                  <Button
                    className="gap-2"
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <SlidersHorizontal className="size-4" />
                    Tags
                    <ChevronDown
                      className={cn(
                        "size-4 transition-transform",
                        showMobileTags && "rotate-180"
                      )}
                    />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3">
                  <TagFacets
                    activeTags={activeTags}
                    className="rounded-md border border-border/50"
                    onTagRemove={handleTagRemove}
                    onTagSelect={handleTagSelect}
                  />
                </CollapsibleContent>
              </Collapsible>
            </div>

            {hasActiveFilters && (
              <div className="mb-6 flex flex-wrap items-center gap-2">
                <span className="font-mono text-muted-foreground text-xs">
                  Filters:
                </span>
                {activeFilterPills.map((pill) => (
                  <Badge
                    className="font-mono text-[10px]"
                    key={pill}
                    variant="outline"
                  >
                    {pill}
                  </Badge>
                ))}
                {activeTags.map((tag) => (
                  <button
                    className={cn(
                      "group inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10",
                      "px-2.5 py-1 font-mono text-xs text-primary transition-all duration-150",
                      "hover:border-primary/50 hover:bg-primary/20"
                    )}
                    key={tag}
                    onClick={() => handleTagRemove(tag)}
                    type="button"
                  >
                    <span>{`${tagMode}:${tag}`}</span>
                    <XIcon className="size-3 opacity-60 transition-opacity group-hover:opacity-100" />
                  </button>
                ))}
                <button
                  className="font-mono text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => {
                    setActiveTags([]);
                    clearAdvancedFilters();
                  }}
                  type="button"
                >
                  Clear all
                </button>
              </div>
            )}

            {error && (
              <Card className="mb-6 border-destructive bg-destructive/10">
                <CardContent className="py-4 text-destructive">
                  {error}
                </CardContent>
              </Card>
            )}

            {loading && (
              <div className="flex flex-col items-center justify-center gap-4 py-20">
                <Loader className="text-primary" size={32} />
                <p className="text-muted-foreground">Searching...</p>
              </div>
            )}

            {!loading && searched && results.length === 0 && !error && (
              <div className="py-20 text-center">
                <div className="relative mx-auto mb-6 size-20">
                  <div className="absolute inset-0 animate-pulse rounded-full bg-primary/10" />
                  <div className="absolute inset-2 rounded-full bg-card" />
                  <FileText className="absolute inset-0 m-auto size-8 text-muted-foreground" />
                </div>
                <h3 className="mb-2 font-semibold text-xl">No matches found</h3>
                <p className="mx-auto mb-6 max-w-sm text-muted-foreground">
                  We couldn't find any documents matching "{query}". Try fewer
                  filters, different keywords, or another depth mode.
                </p>
                <div className="flex justify-center gap-3">
                  <Button
                    onClick={() => setQuery("")}
                    size="sm"
                    variant="outline"
                  >
                    Clear search
                  </Button>
                  {hasActiveFilters && (
                    <Button
                      onClick={() => {
                        setActiveTags([]);
                        clearAdvancedFilters();
                      }}
                      size="sm"
                      variant="outline"
                    >
                      Clear filters
                    </Button>
                  )}
                  <Button onClick={cycleThoroughness} size="sm" variant="ghost">
                    Try different mode
                  </Button>
                </div>
              </div>
            )}

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
                      {meta.queryModes &&
                        (meta.queryModes.term > 0 ||
                          meta.queryModes.intent > 0 ||
                          meta.queryModes.hyde) && (
                          <Badge
                            className="font-mono text-[10px]"
                            variant="secondary"
                          >
                            modes
                          </Badge>
                        )}
                    </div>
                  )}
                </div>
                {results.map((result, i) => (
                  <Card
                    className="group animate-fade-in cursor-pointer opacity-0 transition-all duration-200 hover:border-primary/50 hover:bg-card/80 hover:shadow-[0_0_24px_-10px_hsl(var(--primary)/0.12)]"
                    key={`${result.docid}-${i}`}
                    onClick={() =>
                      navigate(
                        buildDocDeepLink({
                          uri: result.uri,
                          view: result.snippetRange ? "source" : "rendered",
                          lineStart: result.snippetRange?.startLine,
                          lineEnd: result.snippetRange?.endLine,
                        })
                      )
                    }
                    style={{ animationDelay: `${i * 0.05}s` }}
                  >
                    <CardContent className="py-4">
                      <div className="mb-2 flex items-start justify-between gap-4">
                        <h3 className="font-medium text-primary underline-offset-2 group-hover:underline">
                          {result.title || result.uri.split("/").pop()}
                        </h3>
                        <Badge
                          className="shrink-0 font-mono text-xs"
                          variant="secondary"
                        >
                          {(result.score * 100).toFixed(0)}%
                        </Badge>
                      </div>
                      <p className="line-clamp-3 text-muted-foreground text-sm leading-relaxed">
                        {renderSnippet(result.snippet)}
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <p className="truncate font-mono text-muted-foreground/60 text-xs">
                          {result.uri}
                        </p>
                        {result.snippetRange && (
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/40">
                            L{result.snippetRange.startLine}-
                            {result.snippetRange.endLine}
                          </span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
