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
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../hooks/use-api";
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

export interface CaptureModalProps {
  /** Whether the modal is open */
  open: boolean;
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
  jobId: string;
  note: string;
}

interface CollectionsResponse {
  collections: Collection[];
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
  onOpenChange,
  onSuccess,
}: CaptureModalProps) {
  // Form state
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [collection, setCollection] = useState("");
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tags, setTags] = useState<string[]>([]);

  // Submission state
  const [state, setState] = useState<ModalState>("form");
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [createdUri, setCreatedUri] = useState<string | null>(null);

  // Load collections
  useEffect(() => {
    if (!open) return;

    void apiFetch<CollectionsResponse>("/api/status").then(({ data }) => {
      if (data?.collections) {
        setCollections(
          data.collections.map((c) => ({ name: c.name, path: c.path }))
        );

        // Restore last used collection or default to first
        const lastUsed = localStorage.getItem(STORAGE_KEY);
        if (lastUsed && data.collections.some((c) => c.name === lastUsed)) {
          setCollection(lastUsed);
        } else if (data.collections.length > 0) {
          setCollection(data.collections[0].name);
        }
      }
    });
  }, [open]);

  // Reset form when modal closes
  useEffect(() => {
    if (!open) {
      // Small delay to let close animation finish
      const timer = setTimeout(() => {
        setTitle("");
        setContent("");
        setTags([]);
        setState("form");
        setError(null);
        setJobId(null);
        setCreatedUri(null);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Validate form
  const isValid = title.trim() && content.trim() && collection;

  // Submit form
  const handleSubmit = useCallback(async () => {
    if (!isValid) return;

    setState("submitting");
    setError(null);

    const filename = sanitizeFilename(title) || "untitled";
    const relPath = `${filename}.md`;

    // Include tags in the POST request (server writes to frontmatter)
    const { data, error: err } = await apiFetch<CreateDocResponse>(
      "/api/docs",
      {
        method: "POST",
        body: JSON.stringify({
          collection,
          relPath,
          content,
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
  }, [isValid, title, collection, content, tags, onSuccess]);

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
                onChange={(e) => setContent(e.target.value)}
                placeholder="# My note&#10;&#10;Write your content here..."
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
    </Dialog>
  );
}
