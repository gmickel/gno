import {
  FilePlusIcon,
  FileTextIcon,
  FolderIcon,
  Loader2Icon,
  SearchIcon,
  StarIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CaptureModalOpenOptions } from "../hooks/useCaptureModal";

import { apiFetch } from "../hooks/use-api";
import { buildDocDeepLink } from "../lib/deep-links";
import {
  loadFavoriteCollections,
  loadFavoriteDocuments,
  loadRecentDocuments,
  type FavoriteCollection,
  type FavoriteDoc,
  type RecentDoc,
} from "../lib/navigation-state";
import {
  getWorkspaceActions,
  runWorkspaceAction,
} from "../lib/workspace-actions";
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

export interface QuickSwitcherProps {
  location: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigate: (to: string) => void;
  onCreateNote: (options?: string | CaptureModalOpenOptions) => void;
}

export function QuickSwitcher({
  location,
  open,
  onOpenChange,
  navigate,
  onCreateNote,
}: QuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [recentDocs, setRecentDocs] = useState<RecentDoc[]>([]);
  const [favoriteDocs, setFavoriteDocs] = useState<FavoriteDoc[]>([]);
  const [favoriteCollections, setFavoriteCollections] = useState<
    FavoriteCollection[]
  >([]);
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
    setFavoriteDocs(loadFavoriteDocuments());
    setFavoriteCollections(loadFavoriteCollections());
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
  const favoriteDocItems = useMemo(
    () => favoriteDocs.slice(0, 6),
    [favoriteDocs]
  );
  const favoriteCollectionItems = useMemo(
    () => favoriteCollections.slice(0, 6),
    [favoriteCollections]
  );
  const workspaceActions = useMemo(
    () => getWorkspaceActions({ location }),
    [location]
  );
  const exactResult = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return null;
    }

    return (
      results.find((result) => {
        const normalizedTitle = (result.title ?? "").trim().toLowerCase();
        const normalizedLeaf = decodeURIComponent(
          result.uri.split("/").pop() ?? ""
        )
          .replace(/\.[^.]+$/u, "")
          .toLowerCase();
        return (
          normalizedTitle === normalizedQuery ||
          normalizedLeaf === normalizedQuery
        );
      }) ?? null
    );
  }, [query, results]);

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

  const showCreateAction = true;
  const actionHandlers = useMemo(
    () => ({
      navigate,
      openCapture: onCreateNote,
      closePalette: () => onOpenChange(false),
    }),
    [navigate, onCreateNote, onOpenChange]
  );

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

        {!query.trim() &&
          (favoriteDocItems.length > 0 ||
            favoriteCollectionItems.length > 0) && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Favorites">
                {favoriteDocItems.map((item) => (
                  <CommandItem
                    key={item.href}
                    onSelect={() => {
                      navigate(item.href);
                      onOpenChange(false);
                    }}
                    value={`favorite-doc-${item.label}`}
                  >
                    <StarIcon />
                    <span>{item.label}</span>
                    <CommandShortcut>Doc</CommandShortcut>
                  </CommandItem>
                ))}
                {favoriteCollectionItems.map((item) => (
                  <CommandItem
                    key={item.href}
                    onSelect={() => {
                      navigate(item.href);
                      onOpenChange(false);
                    }}
                    value={`favorite-collection-${item.label}`}
                  >
                    <FolderIcon />
                    <span>{item.label}</span>
                    <CommandShortcut>Collection</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

        {showCreateAction && (
          <>
            <CommandGroup heading="Actions">
              {exactResult && (
                <CommandItem
                  onSelect={() =>
                    openTarget({
                      uri: exactResult.uri,
                    })
                  }
                  value={`open-exact-${query}`}
                >
                  <FileTextIcon />
                  <span>Open exact match</span>
                  <CommandShortcut>Exact</CommandShortcut>
                </CommandItem>
              )}
              <CommandItem
                onSelect={() => {
                  onOpenChange(false);
                  onCreateNote({ draftTitle: query.trim() });
                }}
                value={`create-${query}`}
              >
                <FilePlusIcon />
                <span>Create new note</span>
                <CommandShortcut>{query.trim()}</CommandShortcut>
              </CommandItem>
              {workspaceActions
                .filter((action) =>
                  [
                    "new-note-in-context",
                    "create-folder-here",
                    "rename-current-note",
                    "move-current-note",
                    "duplicate-current-note",
                  ].includes(action.id)
                )
                .map((action) => (
                  <CommandItem
                    disabled={!action.available}
                    key={action.id}
                    onSelect={() =>
                      runWorkspaceAction(
                        action,
                        { location },
                        actionHandlers,
                        query.trim()
                      )
                    }
                    value={`${action.label} ${action.keywords.join(" ")} ${query}`}
                  >
                    <FolderIcon />
                    <span>{action.label}</span>
                    <CommandShortcut>
                      {action.id === "new-note-in-context"
                        ? "Context"
                        : "Action"}
                    </CommandShortcut>
                  </CommandItem>
                ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        <CommandGroup heading="Go To">
          {workspaceActions
            .filter((action) => action.group === "Go To" && action.available)
            .map((action) => (
              <CommandItem
                key={action.id}
                onSelect={() =>
                  runWorkspaceAction(
                    action,
                    { location },
                    actionHandlers,
                    query.trim()
                  )
                }
                value={`${action.label} ${action.keywords.join(" ")}`}
              >
                <FolderIcon />
                <span>{action.label}</span>
              </CommandItem>
            ))}
        </CommandGroup>

        {!query.trim() && <CommandSeparator />}

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
