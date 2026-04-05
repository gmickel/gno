/**
 * CaptureModal - Quick document creation modal.
 *
 * Features:
 * - Title, content, collection fields
 * - Auto-generates filename from title
 * - Remembers last used collection
 * - Shows IndexingProgress after creation
 */

import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FolderIcon,
  Loader2Icon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { WikiLinkDoc } from "./WikiLinkAutocomplete";

import {
  getNotePreset,
  NOTE_PRESETS,
  resolveNotePreset,
} from "../../../core/note-presets";
import { apiFetch } from "../hooks/use-api";
import { getActiveWikiLinkQuery } from "../lib/wiki-link";
import { IndexingProgress } from "./IndexingProgress";
import { TagInput } from "./TagInput";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Textarea } from "./ui/textarea";
import { WikiLinkAutocomplete } from "./WikiLinkAutocomplete";

export interface CaptureModalProps {
  /** Whether the modal is open */
  open: boolean;
  /** Prefill title when opening from another surface */
  draftTitle?: string;
  /** Default collection from current workspace context */
  defaultCollection?: string;
  /** Default folder path from current workspace context */
  defaultFolderPath?: string;
  /** Optional preset id */
  presetId?: string;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Callback when document created successfully */
  onSuccess?: (uri: string) => void;
}

interface Collection {
  name: string;
  path: string;
}

interface CreateDocResponse {
  uri: string;
  path: string;
  jobId: string | null;
  note: string;
  openedExisting?: boolean;
  created?: boolean;
  relPath?: string;
}

interface CollectionsResponse {
  collections: Collection[];
}

interface DocsAutocompleteResponse {
  docs: WikiLinkDoc[];
}

const STORAGE_KEY = "gno-last-collection";

function sanitizeFilename(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replaceAll(/[^\w\s-]/g, "")
    .replaceAll(/\s+/g, "-")
    .replaceAll(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

type ModalState = "form" | "submitting" | "success" | "error";

export function CaptureModal({
  open,
  draftTitle = "",
  defaultCollection = "",
  defaultFolderPath = "",
  onOpenChange,
  onSuccess,
  presetId = "",
}: CaptureModalProps) {
  // Form state
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [collection, setCollection] = useState("");
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>(presetId);
  const [contentTouched, setContentTouched] = useState(false);
  const [lastGeneratedContent, setLastGeneratedContent] = useState("");
  const [wikiLinkDocs, setWikiLinkDocs] = useState<WikiLinkDoc[]>([]);
  const [wikiLinkOpen, setWikiLinkOpen] = useState(false);
  const [wikiLinkQuery, setWikiLinkQuery] = useState("");
  const [wikiLinkRange, setWikiLinkRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [wikiLinkPosition, setWikiLinkPosition] = useState({ x: 24, y: 24 });
  const [wikiLinkActiveIndex, setWikiLinkActiveIndex] = useState(-1);
  const contentRef = useRef<HTMLTextAreaElement | null>(null);

  // Submission state
  const [state, setState] = useState<ModalState>("form");
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [createdUri, setCreatedUri] = useState<string | null>(null);

  // Load collections
  useEffect(() => {
    if (!open) return;
    if (draftTitle.trim()) {
      setTitle(draftTitle);
    }
    setSelectedPresetId(presetId || "blank");

    void apiFetch<CollectionsResponse>("/api/status").then(({ data }) => {
      if (data?.collections) {
        setCollections(
          data.collections.map((c) => ({ name: c.name, path: c.path }))
        );

        const requestedCollection = defaultCollection.trim();
        const lastUsed = localStorage.getItem(STORAGE_KEY);
        if (
          requestedCollection &&
          data.collections.some((c) => c.name === requestedCollection)
        ) {
          setCollection(requestedCollection);
        } else if (
          lastUsed &&
          data.collections.some((c) => c.name === lastUsed)
        ) {
          setCollection(lastUsed);
        } else {
          const firstCollection = data.collections.at(0);
          if (firstCollection) {
            setCollection(firstCollection.name);
          }
        }
      }
    });
  }, [defaultCollection, draftTitle, open, presetId]);

  // Reset form when modal closes
  useEffect(() => {
    if (!open) {
      // Small delay to let close animation finish
      const timer = setTimeout(() => {
        setTitle("");
        setContent("");
        setTags([]);
        setContentTouched(false);
        setLastGeneratedContent("");
        setSelectedPresetId("blank");
        setState("form");
        setError(null);
        setJobId(null);
        setCreatedUri(null);
        setWikiLinkDocs([]);
        setWikiLinkOpen(false);
        setWikiLinkQuery("");
        setWikiLinkRange(null);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Validate form
  const isValid = title.trim() && content.trim() && collection;

  useEffect(() => {
    if (!open) {
      return;
    }

    const resolved = resolveNotePreset({
      presetId: selectedPresetId || "blank",
      title: title.trim() || draftTitle.trim() || "Untitled",
      tags,
    });
    const generatedContent = resolved?.content ?? "";
    const shouldApply =
      !contentTouched || !content.trim() || content === lastGeneratedContent;

    setLastGeneratedContent(generatedContent);
    if (shouldApply) {
      setContent(generatedContent);
      if (resolved?.tags) {
        const nextTags = resolved.tags;
        const sameTags =
          nextTags.length === tags.length &&
          nextTags.every((tag, index) => tags[index] === tag);
        if (!sameTags) {
          setTags(nextTags);
        }
      }
    }
  }, [
    content,
    contentTouched,
    draftTitle,
    lastGeneratedContent,
    open,
    selectedPresetId,
    tags,
    title,
  ]);

  // Submit form
  const handleSubmit = useCallback(async () => {
    if (!isValid) return;

    setState("submitting");
    setError(null);

    // Include tags in the POST request (server writes to frontmatter)
    const { data, error: err } = await apiFetch<CreateDocResponse>(
      "/api/docs",
      {
        method: "POST",
        body: JSON.stringify({
          collection,
          title,
          folderPath: defaultFolderPath || undefined,
          content,
          presetId: selectedPresetId || undefined,
          collisionPolicy: "create_with_suffix",
          ...(tags.length > 0 && { tags }),
        }),
      }
    );

    if (err) {
      setState("error");
      setError(err);
      return;
    }

    if (data) {
      // Save last used collection
      localStorage.setItem(STORAGE_KEY, collection);

      setState("success");
      setJobId(data.jobId);
      setCreatedUri(data.uri);
      onSuccess?.(data.uri);
    }
  }, [
    collection,
    content,
    defaultFolderPath,
    isValid,
    onSuccess,
    selectedPresetId,
    tags,
    title,
  ]);

  // Handle keyboard submit
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && isValid) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [isValid, handleSubmit]
  );

  // Open in editor
  const handleOpenInEditor = () => {
    if (createdUri) {
      onOpenChange(false);
      window.location.href = `/edit?uri=${encodeURIComponent(createdUri)}`;
    }
  };

  const insertWikiLink = useCallback(
    (title: string) => {
      if (!wikiLinkRange) return;
      const nextContent =
        content.slice(0, wikiLinkRange.start) +
        `[[${title}]]` +
        content.slice(wikiLinkRange.end);
      setContent(nextContent);
      setWikiLinkOpen(false);
      setWikiLinkActiveIndex(-1);
      requestAnimationFrame(() => {
        const pos = wikiLinkRange.start + title.length + 4;
        contentRef.current?.focus();
        contentRef.current?.setSelectionRange(pos, pos);
      });
    },
    [content, wikiLinkRange]
  );

  const handleCreateLinkedNote = useCallback(
    async (linkedTitle: string) => {
      const { data, error: err } = await apiFetch<CreateDocResponse>(
        "/api/docs",
        {
          method: "POST",
          body: JSON.stringify({
            collection,
            title: linkedTitle,
            folderPath: defaultFolderPath || undefined,
            content: `# ${linkedTitle}\n`,
            collisionPolicy: "open_existing",
          }),
        }
      );
      if (err) {
        setError(err);
        return;
      }
      insertWikiLink(linkedTitle);
      if (data) {
        setWikiLinkDocs((current) => [
          ...current,
          {
            title: linkedTitle,
            uri: data.uri,
            docid: data.uri,
            collection,
          },
        ]);
      }
    },
    [collection, defaultFolderPath, insertWikiLink]
  );

  const handleContentInput = useCallback((nextContent: string) => {
    setContentTouched(true);
    setContent(nextContent);
    const cursorPos = contentRef.current?.selectionStart ?? nextContent.length;
    const activeQuery = getActiveWikiLinkQuery(nextContent, cursorPos);
    if (!activeQuery) {
      setWikiLinkOpen(false);
      setWikiLinkRange(null);
      return;
    }

    const textareaRect = contentRef.current?.getBoundingClientRect();
    setWikiLinkRange({ start: activeQuery.start, end: activeQuery.end });
    setWikiLinkQuery(activeQuery.query);
    setWikiLinkPosition({
      x: textareaRect?.left ?? 24,
      y: (textareaRect?.top ?? 24) + 40,
    });
    setWikiLinkOpen(true);
    setWikiLinkActiveIndex(0);
  }, []);

  useEffect(() => {
    if (!wikiLinkOpen) return;

    const params = new URLSearchParams({
      limit: "8",
      query: wikiLinkQuery,
    });
    if (collection) {
      params.set("collection", collection);
    }

    void apiFetch<DocsAutocompleteResponse>(
      `/api/docs/autocomplete?${params.toString()}`
    ).then(({ data }) => {
      setWikiLinkDocs(data?.docs ?? []);
    });
  }, [collection, wikiLinkOpen, wikiLinkQuery]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>
            {state === "success" ? "Note created" : "New note"}
          </DialogTitle>
          {state === "form" && (
            <DialogDescription>
              Create a new markdown document in your collection.
            </DialogDescription>
          )}
        </DialogHeader>

        {/* Form state */}
        {(state === "form" || state === "submitting") && (
          <div className="space-y-4">
            {/* Title */}
            <div>
              <label
                className="mb-1.5 block font-medium text-sm"
                htmlFor="capture-title"
              >
                Title
              </label>
              <Input
                autoFocus
                disabled={state === "submitting"}
                id="capture-title"
                onChange={(e) => setTitle(e.target.value)}
                placeholder="My new note"
                value={title}
              />
              {title && (
                <p className="mt-1 font-mono text-muted-foreground text-xs">
                  {sanitizeFilename(title) || "untitled"}.md
                </p>
              )}
            </div>

            {/* Content */}
            <div>
              <label
                className="mb-1.5 block font-medium text-sm"
                htmlFor="capture-content"
              >
                Content
              </label>
              <Textarea
                className="min-h-[150px] font-mono text-sm"
                disabled={state === "submitting"}
                id="capture-content"
                onChange={(e) => handleContentInput(e.target.value)}
                placeholder="# My note&#10;&#10;Write your content here..."
                ref={contentRef}
                value={content}
              />
            </div>

            {/* Collection */}
            <div>
              <label
                className="mb-1.5 block font-medium text-sm"
                htmlFor="capture-collection"
              >
                Collection
              </label>
              <Select
                disabled={state === "submitting" || collections.length === 0}
                onValueChange={setCollection}
                value={collection}
              >
                <SelectTrigger className="w-full" id="capture-collection">
                  <SelectValue placeholder="Select a collection" />
                </SelectTrigger>
                <SelectContent>
                  {collections.map((c) => (
                    <SelectItem key={c.name} value={c.name}>
                      <div className="flex items-center gap-2">
                        <FolderIcon className="size-4 text-muted-foreground" />
                        {c.name}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {collections.length === 0 && (
                <p className="mt-1 text-muted-foreground text-xs">
                  No collections found. Add one first.
                </p>
              )}
            </div>

            {/* Preset */}
            <div>
              <label
                className="mb-1.5 block font-medium text-sm"
                htmlFor="capture-preset"
              >
                Preset
              </label>
              <Select
                disabled={state === "submitting"}
                onValueChange={setSelectedPresetId}
                value={selectedPresetId}
              >
                <SelectTrigger className="w-full" id="capture-preset">
                  <SelectValue placeholder="Select a preset" />
                </SelectTrigger>
                <SelectContent>
                  {NOTE_PRESETS.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {getNotePreset(selectedPresetId)?.description && (
                <p className="mt-1 text-muted-foreground text-xs">
                  {getNotePreset(selectedPresetId)?.description}
                </p>
              )}
            </div>

            {defaultFolderPath && (
              <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
                <div className="mb-1 font-mono text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
                  Target location
                </div>
                <div className="font-mono text-xs text-muted-foreground">
                  {collection || defaultCollection} / {defaultFolderPath}
                </div>
              </div>
            )}

            {/* Tags */}
            <div>
              <span className="mb-1.5 block font-medium text-sm">
                Tags
                <span className="ml-1 font-normal text-muted-foreground">
                  (optional)
                </span>
              </span>
              <TagInput
                aria-label="Add tags to this note"
                disabled={state === "submitting"}
                onChange={setTags}
                placeholder="Add tags..."
                value={tags}
              />
            </div>
          </div>
        )}

        {/* Error state */}
        {state === "error" && error && (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertCircleIcon className="size-6 text-destructive" />
            </div>
            <div>
              <h3 className="font-medium text-destructive">
                Failed to create note
              </h3>
              <p className="mt-1 text-muted-foreground text-sm">{error}</p>
            </div>
            <Button onClick={() => setState("form")} variant="outline">
              Try again
            </Button>
          </div>
        )}

        {/* Success state */}
        {state === "success" && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-green-500/10">
                <CheckCircle2Icon className="size-5 text-green-500" />
              </div>
              <div>
                <h3 className="font-medium">Note created successfully</h3>
                <p className="text-muted-foreground text-sm">
                  Indexing in progress...
                </p>
              </div>
            </div>

            {jobId && (
              <div className="rounded-lg border border-border/50 p-3">
                <IndexingProgress compact jobId={jobId} />
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <DialogFooter className="gap-2 sm:gap-0">
          {state === "form" && (
            <>
              <Button onClick={() => onOpenChange(false)} variant="outline">
                Cancel
              </Button>
              <Button disabled={!isValid} onClick={handleSubmit}>
                Create note
              </Button>
            </>
          )}

          {state === "submitting" && (
            <Button disabled>
              <Loader2Icon className="mr-1.5 size-4 animate-spin" />
              Creating...
            </Button>
          )}

          {state === "success" && (
            <>
              <Button onClick={() => onOpenChange(false)} variant="outline">
                Close
              </Button>
              <Button onClick={handleOpenInEditor}>
                <ExternalLinkIcon className="mr-1.5 size-4" />
                Open in editor
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
      <WikiLinkAutocomplete
        activeIndex={wikiLinkActiveIndex}
        docs={wikiLinkDocs}
        isOpen={wikiLinkOpen}
        onActiveIndexChange={setWikiLinkActiveIndex}
        onCreateNew={(linkedTitle) => {
          void handleCreateLinkedNote(linkedTitle);
        }}
        onDismiss={() => setWikiLinkOpen(false)}
        onSelect={(linkedTitle) => insertWikiLink(linkedTitle)}
        position={wikiLinkPosition}
        searchQuery={wikiLinkQuery}
      />
    </Dialog>
  );
}
