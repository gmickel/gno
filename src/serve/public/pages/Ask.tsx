import {
  ArrowLeft,
  BookOpen,
  CornerDownLeft,
  FileText,
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
import { Textarea } from "../components/ui/textarea";
import { apiFetch } from "../hooks/use-api";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

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
    // Add text before citation
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

  // Add remaining text
  if (lastIndex < answer.length) {
    parts.push(answer.slice(lastIndex));
  }

  return parts;
}

export default function Ask({ navigate }: PageProps) {
  const [query, setQuery] = useState("");
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [thoroughness, setThoroughness] = useState<Thoroughness>("balanced");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Fetch capabilities on mount
  useEffect(() => {
    async function fetchCapabilities() {
      const { data } = await apiFetch<Capabilities>("/api/capabilities");
      if (data) {
        setCapabilities(data);
        // Auto-select balanced if hybrid available, otherwise fast
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

  // Scroll to bottom when conversation updates
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) {
      return;
    }

    const entryId = crypto.randomUUID();
    const currentQuery = query.trim();

    // Add entry to conversation
    setConversation((prev) => [
      ...prev,
      { id: entryId, query: currentQuery, response: null, loading: true },
    ]);
    setQuery("");

    // Build request body with thoroughness-mapped params
    // fast: BM25-only via noExpand + noRerank
    // balanced: with reranking, no expansion
    // thorough: full pipeline
    const requestBody: Record<string, unknown> = {
      query: currentQuery,
      limit: 5,
    };

    if (thoroughness === "fast") {
      requestBody.noExpand = true;
      requestBody.noRerank = true;
    } else if (thoroughness === "balanced") {
      requestBody.noExpand = true;
      requestBody.noRerank = false;
    } else {
      // thorough - full pipeline
      requestBody.noExpand = false;
      requestBody.noRerank = false;
    }

    // Make API call
    const { data, error } = await apiFetch<AskResponse>("/api/ask", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });

    // Update conversation with response
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
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit(e);
    }
  };

  const answerAvailable = capabilities?.answer ?? false;

  return (
    <div className="flex min-h-screen flex-col">
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
          <h1 className="font-semibold text-xl">Ask</h1>
          <div className="ml-auto flex items-center gap-4">
            {/* Search depth selector */}
            <ThoroughnessSelector
              disabled={!capabilities?.hybrid}
              onChange={setThoroughness}
              value={thoroughness}
            />

            {/* Divider */}
            <div className="h-6 w-px bg-border/40" />

            {/* AI model selector */}
            <AIModelSelector />

            {/* Capability badges */}
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

      {/* Conversation area */}
      <main className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-3xl space-y-8">
          {/* Empty state */}
          {conversation.length === 0 && (
            <div className="py-20 text-center">
              <Sparkles className="mx-auto mb-4 size-12 text-primary/60" />
              <h2 className="mb-2 font-medium text-lg">Ask anything</h2>
              <p className="text-muted-foreground">
                {answerAvailable
                  ? "Get AI-powered answers with citations from your documents"
                  : "AI answers not available. Install a generation model to enable."}
              </p>
            </div>
          )}

          {/* Conversation entries */}
          {conversation.map((entry) => (
            <div className="space-y-4" key={entry.id}>
              {/* User query */}
              <div className="flex justify-end">
                <div className="max-w-[80%] rounded-lg bg-secondary px-4 py-3">
                  <p className="text-foreground">{entry.query}</p>
                </div>
              </div>

              {/* AI response */}
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
                    {/* Answer */}
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

                    {/* Citations */}
                    {entry.response.citations &&
                      entry.response.citations.length > 0 && (
                        <Sources defaultOpen>
                          <SourcesTrigger
                            count={entry.response.citations.length}
                          />
                          <SourcesContent>
                            {entry.response.citations.map((c, i) => (
                              <Source
                                href="#"
                                key={`${c.docid}-${i}`}
                                onClick={(e) => {
                                  e.preventDefault();
                                  navigate(
                                    `/doc?uri=${encodeURIComponent(c.uri)}`
                                  );
                                }}
                                title={`[${i + 1}] ${c.uri.split("/").pop()}`}
                              >
                                <BookOpen className="size-4 shrink-0" />
                                <span className="truncate">
                                  [{i + 1}] {c.uri.split("/").pop()}
                                </span>
                                {c.startLine && (
                                  <span className="ml-1 font-mono text-[10px] text-muted-foreground/60">
                                    L{c.startLine}
                                    {c.endLine && `-${c.endLine}`}
                                  </span>
                                )}
                              </Source>
                            ))}
                          </SourcesContent>
                        </Sources>
                      )}

                    {/* Meta info */}
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

                    {/* Show retrieved sources if no answer */}
                    {!entry.response.answer &&
                      entry.response.results.length > 0 && (
                        <div className="space-y-2">
                          <p className="font-medium text-muted-foreground text-sm">
                            Search results:
                          </p>
                          {entry.response.results.map((r, i) => (
                            <Card
                              className="cursor-pointer transition-colors hover:border-primary/50"
                              key={`${r.docid}-${i}`}
                              onClick={() =>
                                navigate(
                                  `/doc?uri=${encodeURIComponent(r.uri)}`
                                )
                              }
                            >
                              <CardContent className="py-3">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className="font-medium text-primary text-sm">
                                      {r.title || r.uri.split("/").pop()}
                                    </p>
                                    <p className="line-clamp-2 text-muted-foreground text-xs">
                                      {r.snippet.slice(0, 200)}...
                                    </p>
                                  </div>
                                  <Badge
                                    className="shrink-0 font-mono text-[10px]"
                                    variant="secondary"
                                  >
                                    {(r.score * 100).toFixed(0)}%
                                  </Badge>
                                </div>
                              </CardContent>
                            </Card>
                          ))}
                        </div>
                      )}

                    {/* No results */}
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

      {/* Input area */}
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
