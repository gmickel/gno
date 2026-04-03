/**
 * RelatedNotesSidebar - Semantically similar documents panel.
 *
 * Aesthetic: Specimen cabinet / archive drawer
 * - Related notes displayed like catalogued specimens
 * - Similarity scores as teal "analysis bars" under glass
 * - Subtle brass accents (old gold) on interactive elements
 * - Live updates as content changes (debounced 500ms)
 * - 30s client-side cache for performance
 */

import {
  ChevronDownIcon,
  ChevronRightIcon,
  LinkIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../hooks/use-api";
import { cn } from "../lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface SimilarDoc {
  docid: string;
  uri: string;
  title: string;
  collection: string;
  score: number;
}

interface SimilarResponse {
  similar: SimilarDoc[];
  meta: {
    docid: string;
    totalResults: number;
    limit: number;
    threshold: number;
  };
}

export interface RelatedNotesSidebarProps {
  /** Document ID to find similar docs for */
  docId: string;
  /** Current editor content for live updates */
  content?: string;
  /** Max results to show (default 5) */
  limit?: number;
  /** Minimum similarity threshold (default 0.5) */
  threshold?: number;
  /** Navigate to related document */
  onNavigate: (uri: string) => void;
  /** Additional classes */
  className?: string;
}

// -----------------------------------------------------------------------------
// Cache (30s TTL)
// -----------------------------------------------------------------------------

interface CacheEntry {
  data: SimilarResponse;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 30000; // 30 seconds

function getCached(key: string): SimilarResponse | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: SimilarResponse): void {
  cache.set(key, { data, timestamp: Date.now() });
}

function buildCacheKey(
  docId: string,
  limit: number,
  threshold: number,
  contentHash?: string
): string {
  return `similar:${docId}:${limit}:${threshold}:${contentHash ?? "static"}`;
}

// Simple content hash for cache invalidation
function hashContent(content: string): string {
  let hash = 0;
  for (const char of content) {
    hash = (hash << 5) - hash + char.charCodeAt(0);
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

// -----------------------------------------------------------------------------
// Debounce hook
// -----------------------------------------------------------------------------

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

// -----------------------------------------------------------------------------
// Skeleton loader
// -----------------------------------------------------------------------------

function RelatedNotesSkeleton() {
  return (
    <div className="space-y-2 p-3">
      {[1, 2, 3].map((i) => (
        <div
          className="space-y-1.5 rounded-sm border border-border/30 bg-muted/20 p-2.5"
          key={i}
        >
          {/* Title skeleton */}
          <div
            className="h-4 w-3/4 animate-pulse rounded bg-muted/40"
            style={{ animationDelay: `${i * 80}ms` }}
          />
          {/* Collection badge skeleton */}
          <div
            className="h-3 w-16 animate-pulse rounded bg-muted/30"
            style={{ animationDelay: `${i * 80 + 40}ms` }}
          />
          {/* Score bar skeleton */}
          <div className="mt-2 h-1.5 w-full rounded-full bg-muted/20">
            <div
              className="h-full animate-pulse rounded-full bg-primary/20"
              style={{
                width: `${80 - i * 15}%`,
                animationDelay: `${i * 80 + 80}ms`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Empty state
// -----------------------------------------------------------------------------

function RelatedNotesEmpty() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted/30">
        <LinkIcon className="size-5 text-muted-foreground/50" />
      </div>
      <p className="font-mono text-muted-foreground text-xs">
        No related notes found
      </p>
      <p className="text-muted-foreground/60 text-xs">
        Similar documents will appear here as you write
      </p>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Similarity score bar - "analysis bar under glass"
// -----------------------------------------------------------------------------

function SimilarityBar({ score }: { score: number }) {
  const percentage = Math.round(score * 100);

  return (
    <div className="mt-1 flex items-center gap-2">
      {/* Bar track */}
      <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-muted/30">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-primary/60"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="shrink-0 font-mono text-[9px] text-muted-foreground/50 tabular-nums">
        {percentage}%
      </span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Related note item - specimen card style
// -----------------------------------------------------------------------------

function RelatedNoteItem({
  doc,
  onNavigate,
  index,
}: {
  doc: SimilarDoc;
  onNavigate: () => void;
  index: number;
}) {
  return (
    <button
      className={cn(
        "group relative flex min-w-0 w-full items-start gap-2",
        "rounded px-2 py-1.5 text-left",
        "font-mono text-xs",
        "transition-all duration-150",
        "text-primary/90 hover:bg-muted/20",
        "cursor-pointer hover:translate-x-0.5",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50",
        "animate-fade-in opacity-0"
      )}
      onClick={onNavigate}
      style={{
        animationDelay: `${index * 60}ms`,
        animationFillMode: "forwards",
      }}
      type="button"
    >
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded",
          "bg-primary/15 transition-colors duration-150",
          "group-hover:bg-primary/25"
        )}
      >
        <SparklesIcon className="size-3" />
      </span>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="min-w-0 flex-1">
            <span className="block break-words font-medium leading-tight whitespace-normal text-foreground/90 group-hover:text-foreground">
              {doc.title || "Untitled"}
            </span>
            <SimilarityBar score={doc.score} />
          </div>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-[300px]">
          <p className="break-words">{doc.title || "Untitled"}</p>
        </TooltipContent>
      </Tooltip>
    </button>
  );
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

export function RelatedNotesSidebar({
  docId,
  content,
  limit = 5,
  threshold = 0.5,
  onNavigate,
  className,
}: RelatedNotesSidebarProps) {
  const [similar, setSimilar] = useState<SimilarDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(true);
  const [isVisible, setIsVisible] = useState(true);

  // Request sequencing to prevent race conditions
  const requestIdRef = useRef(0);

  // Debounce content changes (500ms)
  const debouncedContent = useDebounce(content, 500);
  const contentHash = useMemo(
    () => (debouncedContent ? hashContent(debouncedContent) : undefined),
    [debouncedContent]
  );

  // Build cache key
  const cacheKey = useMemo(
    () => buildCacheKey(docId, limit, threshold, contentHash),
    [docId, limit, threshold, contentHash]
  );

  // Fetch similar documents
  const fetchSimilar = useCallback(async () => {
    // Generate request ID for sequencing
    const currentRequestId = ++requestIdRef.current;

    // Check cache first
    const cached = getCached(cacheKey);
    if (cached) {
      setSimilar(cached.similar);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const params = new URLSearchParams({
      limit: String(limit),
      threshold: String(threshold),
    });

    const url = `/api/doc/${encodeURIComponent(docId)}/similar?${params.toString()}`;
    const { data, error: fetchError } = await apiFetch<SimilarResponse>(url);

    // Check if this request is still the latest
    if (currentRequestId !== requestIdRef.current) {
      return; // Stale request, ignore
    }

    if (fetchError || !data) {
      setError(fetchError ?? "Failed to load related notes");
      setLoading(false);
      return;
    }

    // Cache and update state
    setCache(cacheKey, data);
    setSimilar(data.similar);
    setLoading(false);
  }, [cacheKey, docId, limit, threshold]);

  // Fetch on mount and when dependencies change
  useEffect(() => {
    void fetchSimilar();
  }, [fetchSimilar]);

  // Toggle visibility (on/off capability)
  const handleToggleVisibility = useCallback(() => {
    setIsVisible((v) => !v);
  }, []);

  // If hidden, show minimal toggle
  if (!isVisible) {
    return (
      <div className={cn("p-2", className)}>
        <button
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-sm",
            "border border-dashed border-border/40 bg-transparent",
            "px-3 py-2 transition-all duration-200",
            "font-mono text-[11px] text-muted-foreground",
            "hover:border-primary/30 hover:text-primary"
          )}
          onClick={handleToggleVisibility}
          type="button"
        >
          <SparklesIcon className="size-3.5" />
          Show Related Notes
        </button>
      </div>
    );
  }

  return (
    <div className={cn("min-w-0 overflow-hidden px-1", className)}>
      <Collapsible onOpenChange={setIsOpen} open={isOpen}>
        {/* Header */}
        <div className="flex items-center gap-1">
          <CollapsibleTrigger
            className={cn(
              "flex flex-1 items-center gap-2 rounded-sm px-2 py-1.5",
              "transition-colors duration-150",
              "hover:bg-muted/20"
            )}
          >
            {/* Chevron */}
            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/50 transition-transform duration-200">
              {isOpen ? (
                <ChevronDownIcon className="size-3.5" />
              ) : (
                <ChevronRightIcon className="size-3.5" />
              )}
            </span>

            {/* Title */}
            <span className="flex-1 text-left font-mono text-[10px] text-muted-foreground/60 uppercase tracking-[0.15em]">
              Related Notes
            </span>

            {/* Count badge */}
            {similar.length > 0 && (
              <span className="rounded bg-primary/12 px-1.5 py-0.5 font-mono text-[10px] text-primary tabular-nums">
                {similar.length}
              </span>
            )}
          </CollapsibleTrigger>

          {/* Hide button */}
          <button
            className={cn(
              "flex size-5 items-center justify-center rounded-sm",
              "text-muted-foreground/40 transition-colors",
              "hover:bg-muted/20 hover:text-muted-foreground"
            )}
            onClick={handleToggleVisibility}
            title="Hide related notes"
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        </div>

        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapse-up data-[state=open]:animate-collapse-down">
          {/* Content */}
          {loading ? (
            <RelatedNotesSkeleton />
          ) : error ? (
            <div className="p-4 text-center">
              <p className="font-mono text-destructive text-xs">{error}</p>
              <button
                className="mt-2 font-mono text-primary text-xs underline-offset-2 hover:underline"
                onClick={() => void fetchSimilar()}
                type="button"
              >
                Retry
              </button>
            </div>
          ) : similar.length === 0 ? (
            <RelatedNotesEmpty />
          ) : (
            <div className="space-y-0.5 p-2">
              {similar.map((doc, index) => (
                <RelatedNoteItem
                  doc={doc}
                  index={index}
                  key={doc.docid}
                  onNavigate={() => onNavigate(doc.uri)}
                />
              ))}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
