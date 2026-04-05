import {
  FilePlusIcon,
  FileTextIcon,
  FolderIcon,
  Loader2Icon,
  SearchIcon,
  StarIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DocumentSection } from "../../../core/sections";
import type { CaptureModalOpenOptions } from "../hooks/useCaptureModal";

import { NOTE_PRESETS } from "../../../core/note-presets";
import { apiFetch } from "../hooks/use-api";
import { buildDocDeepLink, parseDocumentDeepLink } from "../lib/deep-links";
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

interface DocLookupResponse {
  docid: string;
  uri: string;
}

interface SectionsResponse {
  sections: DocumentSection[];
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
  const [sections, setSections] = useState<DocumentSection[]>([]);
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
    if (!open || !location.startsWith("/doc?")) {
      setSections([]);
      return;
    }

    const target = parseDocumentDeepLink(
      location.includes("?") ? `?${location.split("?")[1] ?? ""}` : ""
    );
    if (!target.uri) {
      setSections([]);
      return;
    }

    void apiFetch<DocLookupResponse>(
      `/api/doc?uri=${encodeURIComponent(target.uri)}`
    ).then(({ data }) => {
      if (!data?.docid) {
        setSections([]);
        return;
      }
      void apiFetch<SectionsResponse>(
        `/api/doc/${encodeURIComponent(data.docid)}/sections`
      ).then(({ data: sectionData }) => {
        setSections(sectionData?.sections ?? []);
      });
    });
  }, [location, open]);

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

  const recentItems = useMemo(() => {
    const seenHref = new Set<string>();
    const seenUri = new Set<string>();
    return recentDocs
      .filter((doc) => {
        if (seenHref.has(doc.href) || seenUri.has(doc.uri)) return false;
        seenHref.add(doc.href);
        seenUri.add(doc.uri);
        return true;
      })
      .slice(0, 6);
  }, [recentDocs]);
  const normalizedQuery = query.trim().toLowerCase();
  const favoriteDocItems = useMemo(
    () => favoriteDocs.slice(0, 6),
    [favoriteDocs]
  );
  const favoriteCollectionItems = useMemo(
    () => favoriteCollections.slice(0, 6),
    [favoriteCollections]
  );
  const filteredRecentItems = useMemo(
    () =>
      recentItems.filter(
        (item) =>
          !normalizedQuery ||
          item.label.toLowerCase().includes(normalizedQuery) ||
          item.uri.toLowerCase().includes(normalizedQuery)
      ),
    [normalizedQuery, recentItems]
  );
  const filteredFavoriteDocItems = useMemo(
    () =>
      favoriteDocItems.filter(
        (item) =>
          !normalizedQuery ||
          item.label.toLowerCase().includes(normalizedQuery) ||
          item.uri.toLowerCase().includes(normalizedQuery)
      ),
    [favoriteDocItems, normalizedQuery]
  );
  const filteredFavoriteCollectionItems = useMemo(
    () =>
      favoriteCollectionItems.filter(
        (item) =>
          !normalizedQuery || item.label.toLowerCase().includes(normalizedQuery)
      ),
    [favoriteCollectionItems, normalizedQuery]
  );
  const workspaceActions = useMemo(
    () => getWorkspaceActions({ location }),
    [location]
  );
  const matchingWorkspaceActions = useMemo(
    () =>
      workspaceActions.filter((action) => {
        if (
          ["new-note", "new-note-in-context", "create-folder-here"].includes(
            action.id
          )
        ) {
          return true;
        }
        if (!normalizedQuery) {
          return true;
        }
        const haystack = [
          action.label,
          action.description ?? "",
          ...action.keywords,
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(normalizedQuery);
      }),
    [normalizedQuery, workspaceActions]
  );
  const exactResult = useMemo(() => {
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
  }, [normalizedQuery, results]);

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
  const filteredPresetActions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return NOTE_PRESETS.filter((preset) => preset.id !== "blank").filter(
      (preset) =>
        !normalizedQuery ||
        preset.label.toLowerCase().includes(normalizedQuery) ||
        preset.description.toLowerCase().includes(normalizedQuery)
    );
  }, [query]);
  const filteredSections = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return sections.filter(
      (section) =>
        !normalizedQuery ||
        section.title.toLowerCase().includes(normalizedQuery)
    );
  }, [query, sections]);

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

        {filteredRecentItems.length > 0 && (
          <CommandGroup heading="Recent">
            {filteredRecentItems.map((item) => (
              <CommandItem
                key={item.href}
                onSelect={() => {
                  navigate(item.href);
                  onOpenChange(false);
                }}
                value={`recent-${item.href}-${item.label}`}
              >
                <FileTextIcon />
                <span>{item.label}</span>
                <CommandShortcut>Recent</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {(filteredFavoriteDocItems.length > 0 ||
          filteredFavoriteCollectionItems.length > 0) && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Favorites">
              {filteredFavoriteDocItems.map((item) => (
                <CommandItem
                  key={item.href}
                  onSelect={() => {
                    navigate(item.href);
                    onOpenChange(false);
                  }}
                  value={`favorite-doc-${item.href}`}
                >
                  <StarIcon />
                  <span>{item.label}</span>
                  <CommandShortcut>Doc</CommandShortcut>
                </CommandItem>
              ))}
              {filteredFavoriteCollectionItems.map((item) => (
                <CommandItem
                  key={item.href}
                  onSelect={() => {
                    navigate(item.href);
                    onOpenChange(false);
                  }}
                  value={`favorite-collection-${item.href}`}
                >
                  <FolderIcon />
                  <span>{item.label}</span>
                  <CommandShortcut>Collection</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {filteredSections.length > 0 && (
          <CommandGroup heading="Sections">
            {filteredSections.map((section) => {
              const target = parseDocumentDeepLink(
                location.includes("?") ? `?${location.split("?")[1] ?? ""}` : ""
              );
              if (!target.uri) {
                return null;
              }
              return (
                <CommandItem
                  key={section.anchor}
                  onSelect={() => {
                    navigate(
                      `${buildDocDeepLink({
                        uri: target.uri,
                        view: "rendered",
                      })}#${section.anchor}`
                    );
                    onOpenChange(false);
                  }}
                  value={`${section.title} section heading outline`}
                >
                  <SearchIcon />
                  <span>{section.title}</span>
                  <CommandShortcut>{`H${section.level}`}</CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>
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
              {matchingWorkspaceActions
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
                    value={`${
                      action.id === "new-note-in-context" ||
                      action.id === "new-note"
                        ? `${action.label} ${action.keywords.join(" ")} ${query}`
                        : `${action.label} ${action.keywords.join(" ")}`
                    }`}
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
          {matchingWorkspaceActions
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

        {filteredPresetActions.length > 0 && (
          <CommandGroup heading="Presets">
            {filteredPresetActions.map((preset) => (
              <CommandItem
                key={preset.id}
                onSelect={() => {
                  onCreateNote({
                    draftTitle: query.trim() || undefined,
                    presetId: preset.id,
                  });
                  onOpenChange(false);
                }}
                value={`${preset.label} ${preset.description} preset`}
              >
                <FilePlusIcon />
                <span>{preset.label}</span>
                <CommandShortcut>Preset</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

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
