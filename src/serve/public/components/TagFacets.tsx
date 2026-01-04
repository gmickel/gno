/**
 * TagFacets - Sidebar tag filter with hierarchical grouping.
 *
 * Aesthetic: Specimen cabinet / library index drawer
 * - Tags organized like specimens in a naturalist's drawer
 * - Collapsible groups with brass handle accents
 * - Active tags glow like pinned specimens under glass
 * - Taxonomy tree visual with connecting lines
 */

import { ChevronDownIcon, ChevronRightIcon, TagIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiFetch } from "../hooks/use-api";
import { cn } from "../lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";

interface TagData {
  tag: string;
  count: number;
}

interface TagsResponse {
  tags: TagData[];
  meta: { totalTags: number };
}

export interface TagFacetsProps {
  /** Currently selected filter tags */
  activeTags: string[];
  /** Add tag to filter */
  onTagSelect: (tag: string) => void;
  /** Remove tag from filter */
  onTagRemove: (tag: string) => void;
  /** Optional collection filter */
  collection?: string;
  /** Additional classes */
  className?: string;
}

/** Simple in-memory cache with TTL */
interface CacheEntry {
  data: TagsResponse;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 30000; // 30 seconds

function getCached(key: string): TagsResponse | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: TagsResponse): void {
  cache.set(key, { data, timestamp: Date.now() });
}

/** Group tags by their prefix for hierarchy display */
interface TagGroup {
  prefix: string;
  tags: TagData[];
}

function groupTags(tags: TagData[]): TagGroup[] {
  const groups = new Map<string, TagData[]>();

  // First pass: identify all prefixes and root tags
  for (const t of tags) {
    const slashIdx = t.tag.indexOf("/");
    if (slashIdx > 0) {
      const prefix = t.tag.slice(0, slashIdx);
      if (!groups.has(prefix)) {
        groups.set(prefix, []);
      }
      groups.get(prefix)!.push(t);
    } else {
      // Root-level tag
      if (!groups.has("")) {
        groups.set("", []);
      }
      groups.get("")!.push(t);
    }
  }

  // Convert to array and sort
  const result: TagGroup[] = [];

  // Root tags first
  const rootTags = groups.get("");
  if (rootTags && rootTags.length > 0) {
    result.push({
      prefix: "",
      tags: rootTags.sort((a, b) => b.count - a.count),
    });
  }

  // Then grouped tags, sorted by prefix
  const prefixes = Array.from(groups.keys())
    .filter((p) => p !== "")
    .sort();

  for (const prefix of prefixes) {
    const prefixTags = groups.get(prefix)!;
    result.push({
      prefix,
      tags: prefixTags.sort((a, b) => b.count - a.count),
    });
  }

  return result;
}

/** Loading skeleton */
function TagFacetsSkeleton() {
  return (
    <div className="space-y-3 p-3">
      {/* Fake group headers */}
      {[1, 2, 3].map((i) => (
        <div className="space-y-2" key={i}>
          <div
            className="h-4 w-20 animate-pulse rounded bg-muted/50"
            style={{ animationDelay: `${i * 100}ms` }}
          />
          <div className="space-y-1.5 pl-3">
            {[1, 2].map((j) => (
              <div
                className="h-6 animate-pulse rounded bg-muted/30"
                key={j}
                style={{ animationDelay: `${(i * 2 + j) * 80}ms` }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Empty state */
function TagFacetsEmpty() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted/30">
        <TagIcon className="size-5 text-muted-foreground/50" />
      </div>
      <p className="font-mono text-muted-foreground text-xs">No tags found</p>
      <p className="text-muted-foreground/60 text-xs">
        Add tags to your documents to see them here
      </p>
    </div>
  );
}

/** Individual tag item */
function TagItem({
  tag,
  count,
  isActive,
  isChild,
  onSelect,
  onRemove,
}: {
  tag: string;
  count: number;
  isActive: boolean;
  isChild: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const displayName = isChild ? tag.split("/").pop() : tag;

  return (
    <button
      className={cn(
        // Base style - specimen card feel
        "group relative flex w-full items-center justify-between gap-2",
        "rounded-sm px-2 py-1.5",
        "font-mono text-xs",
        "transition-all duration-150",
        // Hierarchy indent with connecting line
        isChild && "ml-3 border-muted/30 border-l pl-3",
        // Default state
        !isActive && [
          "text-foreground/80",
          "hover:bg-muted/40 hover:text-foreground",
        ],
        // Active state - pinned specimen under glass
        isActive && [
          "bg-primary/10 text-primary",
          "shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.3)]",
          // Subtle glow
          "before:absolute before:inset-0 before:-z-10 before:rounded-sm",
          "before:bg-primary/5 before:blur-sm",
        ]
      )}
      onClick={isActive ? onRemove : onSelect}
      type="button"
    >
      {/* Tag name */}
      <span className="truncate">{displayName}</span>

      {/* Count badge - brass plate aesthetic */}
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-0.5",
          "font-mono text-[10px] tabular-nums",
          "transition-colors duration-150",
          !isActive && "bg-secondary/10 text-secondary/70",
          isActive && "bg-primary/20 text-primary"
        )}
      >
        {count}
      </span>
    </button>
  );
}

/** Collapsible tag group */
function TagGroupSection({
  group,
  activeTags,
  onTagSelect,
  onTagRemove,
  defaultOpen = true,
}: {
  group: TagGroup;
  activeTags: string[];
  onTagSelect: (tag: string) => void;
  onTagRemove: (tag: string) => void;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  // Count active tags in this group
  const activeCount = group.tags.filter((t) =>
    activeTags.includes(t.tag)
  ).length;

  // Root-level tags (no prefix) don't need a collapsible wrapper
  if (!group.prefix) {
    return (
      <div className="space-y-0.5">
        {group.tags.map((t) => (
          <TagItem
            count={t.count}
            isActive={activeTags.includes(t.tag)}
            isChild={false}
            key={t.tag}
            onRemove={() => onTagRemove(t.tag)}
            onSelect={() => onTagSelect(t.tag)}
            tag={t.tag}
          />
        ))}
      </div>
    );
  }

  return (
    <Collapsible onOpenChange={setIsOpen} open={isOpen}>
      <CollapsibleTrigger
        className={cn(
          // Group header - drawer handle aesthetic
          "group flex w-full items-center gap-1.5",
          "rounded-sm px-1.5 py-1",
          "transition-colors duration-150",
          "hover:bg-muted/30",
          // Active indicator when group has selected tags
          activeCount > 0 && "text-primary"
        )}
      >
        {/* Chevron */}
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/60 transition-transform duration-200">
          {isOpen ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </span>

        {/* Prefix name - brass label style */}
        <span
          className={cn(
            "flex-1 truncate text-left font-mono text-[11px] uppercase tracking-wider",
            activeCount > 0 ? "text-primary/80" : "text-muted-foreground"
          )}
        >
          {group.prefix}
        </span>

        {/* Group count */}
        <span className="font-mono text-[10px] text-muted-foreground/50">
          {group.tags.length}
        </span>

        {/* Active indicator dot */}
        {activeCount > 0 && (
          <span className="size-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_4px_hsl(var(--primary))]" />
        )}
      </CollapsibleTrigger>

      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapse-up data-[state=open]:animate-collapse-down">
        <div className="mt-0.5 space-y-0.5 pb-1">
          {group.tags.map((t) => (
            <TagItem
              count={t.count}
              isActive={activeTags.includes(t.tag)}
              isChild={true}
              key={t.tag}
              onRemove={() => onTagRemove(t.tag)}
              onSelect={() => onTagSelect(t.tag)}
              tag={t.tag}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function TagFacets({
  activeTags,
  onTagSelect,
  onTagRemove,
  collection,
  className,
}: TagFacetsProps) {
  const [tags, setTags] = useState<TagData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Build cache key
  const cacheKey = `tags:${collection ?? "all"}`;

  // Fetch tags
  const fetchTags = useCallback(async () => {
    // Check cache first
    const cached = getCached(cacheKey);
    if (cached) {
      setTags(cached.tags);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (collection) {
      params.set("collection", collection);
    }

    const url = `/api/tags${params.toString() ? `?${params.toString()}` : ""}`;
    const { data, error: fetchError } = await apiFetch<TagsResponse>(url);

    if (fetchError || !data) {
      setError(fetchError ?? "Failed to load tags");
      setLoading(false);
      return;
    }

    // Cache and update state
    setCache(cacheKey, data);
    setTags(data.tags);
    setLoading(false);
  }, [cacheKey, collection]);

  // Initial fetch
  useEffect(() => {
    void fetchTags();
  }, [fetchTags]);

  // Group tags by prefix
  const groupedTags = useMemo(() => groupTags(tags), [tags]);

  // Render
  if (loading) {
    return (
      <div className={className}>
        <TagFacetsSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("p-4 text-center", className)}>
        <p className="font-mono text-destructive text-xs">{error}</p>
        <button
          className="mt-2 font-mono text-primary text-xs underline-offset-2 hover:underline"
          onClick={() => void fetchTags()}
          type="button"
        >
          Retry
        </button>
      </div>
    );
  }

  if (tags.length === 0) {
    return (
      <div className={className}>
        <TagFacetsEmpty />
      </div>
    );
  }

  return (
    <div className={cn("space-y-1 p-2", className)}>
      {/* Header */}
      <div className="mb-2 flex items-center justify-between px-1.5">
        <h3 className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
          Tags
        </h3>
        {activeTags.length > 0 && (
          <button
            className="font-mono text-[10px] text-primary/70 underline-offset-2 hover:text-primary hover:underline"
            onClick={() => {
              for (const tag of activeTags) {
                onTagRemove(tag);
              }
            }}
            type="button"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Tag groups */}
      <div className="space-y-1">
        {groupedTags.map((group) => (
          <TagGroupSection
            activeTags={activeTags}
            defaultOpen={true}
            group={group}
            key={group.prefix || "_root"}
            onTagRemove={onTagRemove}
            onTagSelect={onTagSelect}
          />
        ))}
      </div>
    </div>
  );
}
