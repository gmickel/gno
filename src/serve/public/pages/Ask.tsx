import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  CornerDownLeft,
  FileText,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Loader } from "../components/ai-elements/loader";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "../components/ai-elements/sources";
import { AIModelSelector } from "../components/AIModelSelector";
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
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { parseTagsCsv, type TagMode } from "../lib/retrieval-filters";
import { cn } from "../lib/utils";

interface PageProps {
  navigate: (to: string | number) => void;
}

interface Citation {
  docid: string;
  uri: string;
  startLine?: number;
  endLine?: number;
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

interface AskResponse {
  query: string;
  mode: string;
  queryLanguage: string;
  answer?: string;
  citations?: Citation[];
  results: SearchResult[];
  meta: {
    expanded: boolean;
    reranked: boolean;
    vectorsUsed: boolean;
    answerGenerated: boolean;
    totalResults: number;
  };
}

interface Capabilities {
  bm25: boolean;
  vector: boolean;
  hybrid: boolean;
  answer: boolean;
}

interface ConversationEntry {
  id: string;
  query: string;
  response: AskResponse | null;
  loading: boolean;
  error?: string;
}

interface Collection {
  name: string;
}

const THOROUGHNESS_ORDER: Thoroughness[] = ["fast", "balanced", "thorough"];

/**
 * Render answer text with clickable citation badges.
 * Citations like [1] become clickable to navigate to source.
 */
function renderAnswer(
  answer: string,
  citations: Citation[],
  navigate: (to: string) => void
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let key = 0;

  const citationRegex = /\[(\d+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // oxlint-disable-next-line no-cond-assign -- Standard regex match pattern
  while ((match = citationRegex.exec(answer)) !== null) {
    if (match.index > lastIndex) {
      parts.push(answer.slice(lastIndex, match.index));
    }

    const citationNum = Number(match[1]);
    const citation = citations[citationNum - 1];

    if (citation) {
      parts.push(
        <button
          className="mx-0.5 inline-flex items-center rounded bg-primary/20 px-1.5 py-0.5 font-mono text-primary text-xs transition-colors hover:bg-primary/30"
          key={key++}
          onClick={() =>
            navigate(`/doc?uri=${encodeURIComponent(citation.uri)}`)
          }
          type="button"
        >
          {citationNum}
        </button>
      );
    } else {
      parts.push(match[0]);
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < answer.length) {
    parts.push(answer.slice(lastIndex));
  }

  return parts;
}

export default function Ask({ navigate }: PageProps) {
  const [query, setQuery] = useState("");
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [thoroughness, setThoroughness] = useState<Thoroughness>("balanced");

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedCollection, setSelectedCollection] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [category, setCategory] = useState("");
  const [author, setAuthor] = useState("");
  const [tagMode, setTagMode] = useState<TagMode>("any");
  const [tagsInput, setTagsInput] = useState("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const hybridAvailable = capabilities?.hybrid ?? false;

  useEffect(() => {
    async function bootstrap(): Promise<void> {
      const [capsResult, collectionsResult] = await Promise.all([
        apiFetch<Capabilities>("/api/capabilities"),
        apiFetch<Collection[]>("/api/collections"),
      ]);

      if (capsResult.data) {
        const caps = capsResult.data;
        setCapabilities(caps);
        setThoroughness(caps.hybrid ? "balanced" : "fast");
      }

      if (collectionsResult.data) {
        setCollections(collectionsResult.data);
      }
    }

    void bootstrap();
  }, []);

  const cycleThoroughness = useCallback(() => {
    setThoroughness((current) => {
      if (!hybridAvailable) {
        return "fast";
      }
      const currentIdx = THOROUGHNESS_ORDER.indexOf(current);
      const nextIdx = (currentIdx + 1) % THOROUGHNESS_ORDER.length;
      return THOROUGHNESS_ORDER[nextIdx];
    });
  }, [hybridAvailable]);

  const shortcuts = useMemo(
    () => [{ key: "t", action: cycleThoroughness }],
    [cycleThoroughness]
  );
  useKeyboardShortcuts(shortcuts);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!query.trim()) {
        return;
      }

      const entryId = crypto.randomUUID();
      const currentQuery = query.trim();

      setConversation((prev) => [
        ...prev,
        { id: entryId, query: currentQuery, response: null, loading: true },
      ]);
      setQuery("");

      const requestBody: Record<string, unknown> = {
        query: currentQuery,
        limit: 5,
      };

      if (selectedCollection) {
        requestBody.collection = selectedCollection;
      }
      if (since) {
        requestBody.since = since;
      }
      if (until) {
        requestBody.until = until;
      }
      if (category.trim()) {
        requestBody.category = category.trim();
      }
      if (author.trim()) {
        requestBody.author = author.trim();
      }

      const normalizedTags = parseTagsCsv(tagsInput);
      if (normalizedTags.length > 0) {
        if (tagMode === "all") {
          requestBody.tagsAll = normalizedTags.join(",");
        } else {
          requestBody.tagsAny = normalizedTags.join(",");
        }
      }

      if (thoroughness === "fast") {
        requestBody.noExpand = true;
        requestBody.noRerank = true;
      } else if (thoroughness === "balanced") {
        requestBody.noExpand = true;
        requestBody.noRerank = false;
      } else {
        requestBody.noExpand = false;
        requestBody.noRerank = false;
      }

      const { data, error } = await apiFetch<AskResponse>("/api/ask", {
        method: "POST",
        body: JSON.stringify(requestBody),
      });

      setConversation((prev) =>
        prev.map((entry) =>
          entry.id === entryId
            ? {
                ...entry,
                response: data ?? null,
                loading: false,
                error: error ?? undefined,
              }
            : entry
        )
      );
    },
    [
      author,
      category,
      query,
      selectedCollection,
      since,
      tagMode,
      tagsInput,
      thoroughness,
      until,
    ]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit(e);
    }
  };

  const clearFilters = () => {
    setSelectedCollection("");
    setSince("");
    setUntil("");
    setCategory("");
    setAuthor("");
    setTagsInput("");
    setTagMode("any");
  };

  const answerAvailable = capabilities?.answer ?? false;

  const activeFilterPills = [
    selectedCollection ? `collection:${selectedCollection}` : null,
    since ? `since:${since}` : null,
    until ? `until:${until}` : null,
    category.trim() ? `category:${category.trim()}` : null,
    author.trim() ? `author:${author.trim()}` : null,
    parseTagsCsv(tagsInput).length > 0
      ? `${tagMode}:${parseTagsCsv(tagsInput).join(",")}`
      : null,
  ].filter((pill): pill is string => Boolean(pill));

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
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
          <h1 className="font-semibold text-xl">Ask</h1>
          <div className="ml-auto flex items-center gap-4">
            <ThoroughnessSelector
              disabled={!capabilities?.hybrid}
              onChange={setThoroughness}
              value={thoroughness}
            />

            <div className="h-6 w-px bg-border/40" />

            <AIModelSelector />

            {capabilities && (
              <div className="flex items-center gap-2">
                {capabilities.vector && (
                  <Badge className="font-mono text-[10px]" variant="secondary">
                    vectors
                  </Badge>
                )}
                {capabilities.answer && (
                  <Badge className="font-mono text-[10px]" variant="secondary">
                    AI
                  </Badge>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-6 md:p-8">
        <div className="mx-auto max-w-3xl space-y-5">
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
                          setSelectedCollection(value === "all" ? "" : value)
                        }
                        value={selectedCollection || "all"}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="All collections" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All collections</SelectItem>
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

                    <div className="md:col-span-2">
                      <p className="mb-1 text-muted-foreground text-xs">
                        Tags (comma separated)
                      </p>
                      <Input
                        onChange={(e) => setTagsInput(e.target.value)}
                        placeholder="project/alpha, urgent"
                        value={tagsInput}
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
                      onClick={clearFilters}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Clear filters
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </CollapsibleContent>
          </Collapsible>

          {activeFilterPills.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
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
            </div>
          )}

          {conversation.length === 0 && (
            <div className="py-10 text-center md:py-14">
              <Sparkles className="mx-auto mb-4 size-12 text-primary/60" />
              <h2 className="mb-2 font-medium text-lg">Ask anything</h2>
              <p className="text-muted-foreground">
                {answerAvailable
                  ? "Get AI-powered answers with citations from your documents"
                  : "AI answers not available. Install a generation model to enable."}
              </p>
            </div>
          )}

          {conversation.map((entry) => (
            <div className="space-y-4" key={entry.id}>
              <div className="flex justify-end">
                <div className="max-w-[80%] rounded-lg bg-secondary px-4 py-3">
                  <p className="text-foreground">{entry.query}</p>
                </div>
              </div>

              <div className="space-y-3">
                {entry.loading && (
                  <div className="flex items-center gap-3">
                    <Loader className="text-primary" size={20} />
                    <span className="text-muted-foreground text-sm">
                      Thinking...
                    </span>
                  </div>
                )}

                {entry.error && (
                  <Card className="border-destructive bg-destructive/10">
                    <CardContent className="py-4 text-destructive">
                      {entry.error}
                    </CardContent>
                  </Card>
                )}

                {entry.response && (
                  <>
                    {entry.response.answer && (
                      <div className="prose prose-sm prose-invert max-w-none rounded-lg bg-card/50 p-4">
                        <p className="whitespace-pre-wrap leading-relaxed">
                          {renderAnswer(
                            entry.response.answer,
                            entry.response.citations ?? [],
                            navigate
                          )}
                        </p>
                      </div>
                    )}

                    {entry.response.citations &&
                      entry.response.citations.length > 0 && (
                        <Sources defaultOpen>
                          <SourcesTrigger
                            count={entry.response.citations.length}
                          />
                          <SourcesContent>
                            {entry.response.citations.map((citation, i) => (
                              <Source
                                href="#"
                                key={`${citation.docid}-${i}`}
                                onClick={(event) => {
                                  event.preventDefault();
                                  navigate(
                                    `/doc?uri=${encodeURIComponent(citation.uri)}`
                                  );
                                }}
                                title={`[${i + 1}] ${citation.uri.split("/").pop()}`}
                              >
                                <BookOpen className="size-4 shrink-0" />
                                <span className="truncate">
                                  [{i + 1}] {citation.uri.split("/").pop()}
                                </span>
                                {citation.startLine && (
                                  <span className="ml-1 font-mono text-[10px] text-muted-foreground/60">
                                    L{citation.startLine}
                                    {citation.endLine && `-${citation.endLine}`}
                                  </span>
                                )}
                              </Source>
                            ))}
                          </SourcesContent>
                        </Sources>
                      )}

                    <div className="flex items-center gap-2 text-muted-foreground/60 text-xs">
                      <span>{entry.response.results.length} results</span>
                      {entry.response.meta.vectorsUsed && (
                        <Badge
                          className="font-mono text-[9px]"
                          variant="outline"
                        >
                          hybrid
                        </Badge>
                      )}
                      {entry.response.meta.expanded && (
                        <Badge
                          className="font-mono text-[9px]"
                          variant="outline"
                        >
                          expanded
                        </Badge>
                      )}
                    </div>

                    {!entry.response.answer &&
                      entry.response.results.length > 0 && (
                        <div className="space-y-2">
                          <p className="font-medium text-muted-foreground text-sm">
                            Search results:
                          </p>
                          {entry.response.results.map((result, i) => (
                            <Card
                              className="cursor-pointer transition-colors hover:border-primary/50"
                              key={`${result.docid}-${i}`}
                              onClick={() =>
                                navigate(
                                  `/doc?uri=${encodeURIComponent(result.uri)}`
                                )
                              }
                            >
                              <CardContent className="py-3">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className="font-medium text-primary text-sm">
                                      {result.title ||
                                        result.uri.split("/").pop()}
                                    </p>
                                    <p className="line-clamp-2 text-muted-foreground text-xs">
                                      {result.snippet.slice(0, 200)}...
                                    </p>
                                  </div>
                                  <Badge
                                    className="shrink-0 font-mono text-[10px]"
                                    variant="secondary"
                                  >
                                    {(result.score * 100).toFixed(0)}%
                                  </Badge>
                                </div>
                              </CardContent>
                            </Card>
                          ))}
                        </div>
                      )}

                    {!entry.response.answer &&
                      entry.response.results.length === 0 && (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <FileText className="size-4" />
                          <span className="text-sm">
                            No relevant results found
                          </span>
                        </div>
                      )}
                  </>
                )}
              </div>
            </div>
          ))}

          <div ref={messagesEndRef} />
        </div>
      </main>

      <footer className="glass sticky bottom-0 border-border/50 border-t">
        <form
          className="mx-auto flex max-w-3xl items-end gap-3 p-4"
          onSubmit={handleSubmit}
        >
          <div className="relative flex-1">
            <Textarea
              className="min-h-[60px] resize-none pr-12"
              disabled={!answerAvailable}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                answerAvailable
                  ? "Ask a question about your documents..."
                  : "AI answers not available"
              }
              ref={textareaRef}
              rows={1}
              value={query}
            />
            <Button
              className="absolute right-2 bottom-2"
              disabled={!(query.trim() && answerAvailable)}
              size="icon-sm"
              type="submit"
            >
              <CornerDownLeft className="size-4" />
            </Button>
          </div>
        </form>
      </footer>
    </div>
  );
}
