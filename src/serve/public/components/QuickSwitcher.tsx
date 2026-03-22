import {
  FilePlusIcon,
  FileTextIcon,
  Loader2Icon,
  SearchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../hooks/use-api";
import { buildDocDeepLink } from "../lib/deep-links";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./ui/command";

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
}

interface RecentDoc {
  uri: string;
  href: string;
  label: string;
}

export const RECENT_DOCS_STORAGE_KEY = "gno.recent-docs";

export function saveRecentDocument(doc: RecentDoc): void {
  const current = loadRecentDocuments().filter(
    (entry) => entry.href !== doc.href
  );
  const next = [doc, ...current].slice(0, 8);
  localStorage.setItem(RECENT_DOCS_STORAGE_KEY, JSON.stringify(next));
}

export function loadRecentDocuments(): RecentDoc[] {
  try {
    const raw = localStorage.getItem(RECENT_DOCS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is RecentDoc => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as Record<string, unknown>;
      return (
        typeof candidate.uri === "string" &&
        typeof candidate.href === "string" &&
        typeof candidate.label === "string"
      );
    });
  } catch {
    return [];
  }
}

export interface QuickSwitcherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigate: (to: string) => void;
  onCreateNote: () => void;
}

export function QuickSwitcher({
  open,
  onOpenChange,
  navigate,
  onCreateNote,
}: QuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [recentDocs, setRecentDocs] = useState<RecentDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setLoading(false);
      return;
    }
    setRecentDocs(loadRecentDocuments());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    const currentRequestId = ++requestIdRef.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void apiFetch<SearchResponse>("/api/search", {
        method: "POST",
        body: JSON.stringify({
          query,
          limit: 8,
        }),
      }).then(({ data }) => {
        if (currentRequestId !== requestIdRef.current) {
          return;
        }
        setResults(data?.results ?? []);
        setLoading(false);
      });
    }, 120);

    return () => clearTimeout(timer);
  }, [open, query]);

  const recentItems = useMemo(() => recentDocs.slice(0, 6), [recentDocs]);

  const openTarget = useCallback(
    (target: { uri: string; lineStart?: number; lineEnd?: number }) => {
      navigate(
        buildDocDeepLink({
          uri: target.uri,
          view: target.lineStart ? "source" : "rendered",
          lineStart: target.lineStart,
          lineEnd: target.lineEnd,
        })
      );
      onOpenChange(false);
    },
    [navigate, onOpenChange]
  );

  const showCreateAction = query.trim().length > 0;

  return (
    <CommandDialog
      description="Jump to notes, open recent documents, or create a new note."
      onOpenChange={onOpenChange}
      open={open}
      title="Quick Switcher"
    >
      <CommandInput
        autoFocus
        onValueChange={setQuery}
        placeholder="Search notes or create a new one..."
        value={query}
      />
      <CommandList>
        <CommandEmpty>
          {loading ? "Searching..." : "No matching documents."}
        </CommandEmpty>

        {recentItems.length > 0 && !query.trim() && (
          <CommandGroup heading="Recent">
            {recentItems.map((item) => (
              <CommandItem
                key={item.href}
                onSelect={() => {
                  navigate(item.href);
                  onOpenChange(false);
                }}
                value={item.label}
              >
                <FileTextIcon />
                <span>{item.label}</span>
                <CommandShortcut>Recent</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {showCreateAction && (
          <>
            <CommandGroup heading="Actions">
              <CommandItem
                onSelect={() => {
                  onOpenChange(false);
                  onCreateNote();
                }}
                value={`create-${query}`}
              >
                <FilePlusIcon />
                <span>Create new note</span>
                <CommandShortcut>{query.trim()}</CommandShortcut>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {query.trim() && (
          <CommandGroup heading="Documents">
            {results.map((result) => (
              <CommandItem
                key={result.docid}
                onSelect={() =>
                  openTarget({
                    uri: result.uri,
                    lineStart: result.snippetRange?.startLine,
                    lineEnd: result.snippetRange?.endLine,
                  })
                }
                value={`${result.title ?? result.uri} ${result.uri}`}
              >
                {loading ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <SearchIcon />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate">{result.title || result.uri}</div>
                  <div className="truncate text-muted-foreground text-xs">
                    {result.uri}
                  </div>
                </div>
                {result.snippetRange && (
                  <CommandShortcut>
                    L{result.snippetRange.startLine}
                    {result.snippetRange.endLine !==
                    result.snippetRange.startLine
                      ? `-${result.snippetRange.endLine}`
                      : ""}
                  </CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
