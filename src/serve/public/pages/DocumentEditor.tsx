/**
 * DocumentEditor - Split-view markdown editor with auto-save.
 *
 * Features:
 * - CodeMirror 6 for editing
 * - Live markdown preview
 * - Debounced auto-save (2s)
 * - Keyboard shortcuts (Cmd+S to save)
 * - Unsaved changes warning
 */

import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckIcon,
  CloudIcon,
  EyeIcon,
  EyeOffIcon,
  LinkIcon,
  Loader2Icon,
  PenIcon,
  UnlinkIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Loader } from "../components/ai-elements/loader";
import {
  CodeMirrorEditor,
  type CodeMirrorEditorRef,
  MarkdownPreview,
} from "../components/editor";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Separator } from "../components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { apiFetch } from "../hooks/use-api";

interface PageProps {
  navigate: (to: string | number) => void;
}

interface DocData {
  docid: string;
  uri: string;
  title: string | null;
  content: string | null;
  contentAvailable: boolean;
  collection: string;
  relPath: string;
  source: {
    mime: string;
    ext: string;
    modifiedAt?: string;
    sizeBytes?: number;
  };
}

type SaveStatus = "saved" | "saving" | "unsaved" | "error";

function useDebouncedCallback<T extends unknown[]>(
  callback: (...args: T) => void | Promise<void>,
  delay: number
) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debouncedFn = useCallback(
    (...args: T) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        void callback(...args);
      }, delay);
    },
    [callback, delay]
  );

  const cancel = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const flush = useCallback(
    (...args: T) => {
      cancel();
      void callback(...args);
    },
    [callback, cancel]
  );

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return { debouncedFn, cancel, flush };
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function DocumentEditor({ navigate }: PageProps) {
  const [doc, setDoc] = useState<DocData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [showPreview, setShowPreview] = useState(true);
  const [syncScroll, setSyncScroll] = useState(true);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const editorRef = useRef<CodeMirrorEditorRef>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // Event-based suppression: ignore the echo event caused by programmatic scroll
  const ignoreNextEditorScroll = useRef(false);
  const ignoreNextPreviewScroll = useRef(false);

  const hasUnsavedChanges = content !== originalContent;

  // Reset ignore flags when sync is toggled to prevent stale state
  useEffect(() => {
    ignoreNextEditorScroll.current = false;
    ignoreNextPreviewScroll.current = false;
  }, [syncScroll, showPreview]);

  // Scroll sync handlers with event-based loop prevention
  // Note: Uses percentage-based mapping which provides approximate correspondence.
  // For very different layouts (headings, code blocks, images), perfect alignment
  // would require anchor-based mapping between editor lines and rendered elements.
  const handleEditorScroll = useCallback(
    (scrollPercent: number) => {
      // Clear ignore flag first, even if we early-return (prevents lingering)
      if (ignoreNextEditorScroll.current) {
        ignoreNextEditorScroll.current = false;
        return;
      }
      if (!syncScroll || !showPreview) return;
      if (!Number.isFinite(scrollPercent)) return;

      const clamped = Math.max(0, Math.min(1, scrollPercent));
      const preview = previewRef.current;
      if (!preview) return;

      const maxScroll = preview.scrollHeight - preview.clientHeight;
      if (maxScroll <= 0) return;

      const targetScroll = clamped * maxScroll;
      // Only set ignore flag if scroll position actually changes (avoids lingering flag)
      if (Math.abs(preview.scrollTop - targetScroll) > 0.5) {
        ignoreNextPreviewScroll.current = true;
        preview.scrollTop = targetScroll;
      }
    },
    [syncScroll, showPreview]
  );

  const handlePreviewScroll = useCallback(() => {
    // Clear ignore flag first, even if we early-return (prevents lingering)
    if (ignoreNextPreviewScroll.current) {
      ignoreNextPreviewScroll.current = false;
      return;
    }
    if (!syncScroll) return;

    const preview = previewRef.current;
    if (!preview) return;

    const maxScroll = preview.scrollHeight - preview.clientHeight;
    if (maxScroll <= 0) return;

    const scrollPercentRaw = preview.scrollTop / maxScroll;
    if (!Number.isFinite(scrollPercentRaw)) return;
    const scrollPercent = Math.max(0, Math.min(1, scrollPercentRaw));

    // Set ignore flag BEFORE programmatic scroll to prevent race condition
    ignoreNextEditorScroll.current = true;
    const didScroll =
      editorRef.current?.scrollToPercent(scrollPercent) ?? false;
    // Clear flag if no scroll actually occurred (avoids lingering)
    if (!didScroll) {
      ignoreNextEditorScroll.current = false;
    }
  }, [syncScroll]);

  // Save function
  const saveDocument = useCallback(
    async (contentToSave: string) => {
      if (!doc) return;

      setSaveStatus("saving");
      setSaveError(null);

      const { error: err } = await apiFetch(
        `/api/docs/${encodeURIComponent(doc.docid)}`,
        {
          method: "PUT",
          body: JSON.stringify({ content: contentToSave }),
        }
      );

      if (err) {
        setSaveStatus("error");
        setSaveError(err);
      } else {
        setSaveStatus("saved");
        setOriginalContent(contentToSave);
        setLastSaved(new Date());
      }
    },
    [doc]
  );

  // Debounced auto-save
  const { debouncedFn: debouncedSave, flush: flushSave } = useDebouncedCallback(
    saveDocument,
    2000
  );

  // Handle content changes
  const handleContentChange = useCallback(
    (newContent: string) => {
      setContent(newContent);
      if (newContent !== originalContent) {
        setSaveStatus("unsaved");
        debouncedSave(newContent);
      }
    },
    [originalContent, debouncedSave]
  );

  // Force save (Cmd+S)
  const handleForceSave = useCallback(() => {
    if (hasUnsavedChanges) {
      flushSave(content);
    }
  }, [hasUnsavedChanges, flushSave, content]);

  // Load document
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const uri = params.get("uri");

    if (!uri) {
      setError("No document URI provided");
      setLoading(false);
      return;
    }

    void apiFetch<DocData>(`/api/doc?uri=${encodeURIComponent(uri)}`).then(
      ({ data, error: err }) => {
        setLoading(false);
        if (err) {
          setError(err);
        } else if (data) {
          setDoc(data);
          const docContent = data.content ?? "";
          setContent(docContent);
          setOriginalContent(docContent);
          // Ensure CodeMirror reflects content after async load
          requestAnimationFrame(() => {
            editorRef.current?.setValue(docContent);
          });
        }
      }
    );
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;

      // Cmd+S / Ctrl+S - Save
      if (isMeta && e.key === "s") {
        e.preventDefault();
        handleForceSave();
        return;
      }

      // Editor-specific shortcuts - only when focus is in CodeMirror
      const target = e.target as HTMLElement;
      const inEditor = !!target.closest(".cm-editor");

      // Cmd+B - Bold (editor only)
      if (isMeta && e.key === "b" && inEditor) {
        e.preventDefault();
        editorRef.current?.wrapSelection("**", "**");
        return;
      }

      // Cmd+I - Italic (editor only)
      if (isMeta && e.key === "i" && inEditor) {
        e.preventDefault();
        editorRef.current?.wrapSelection("*", "*");
        return;
      }

      // Cmd+K - Link (editor only)
      if (isMeta && e.key === "k" && inEditor) {
        e.preventDefault();
        editorRef.current?.wrapSelection("[", "](url)");
        return;
      }

      // Escape - Close (with warning if unsaved)
      if (e.key === "Escape") {
        e.preventDefault();
        if (hasUnsavedChanges) {
          setShowUnsavedDialog(true);
        } else {
          navigate(-1);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleForceSave, hasUnsavedChanges, navigate]);

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = ""; // Required for modern browsers
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  // Handle close/back
  const handleClose = () => {
    if (hasUnsavedChanges) {
      setShowUnsavedDialog(true);
    } else {
      navigate(-1);
    }
  };

  // Discard and close
  const handleDiscardAndClose = () => {
    setShowUnsavedDialog(false);
    navigate(-1);
  };

  // Save and close
  const handleSaveAndClose = async () => {
    await saveDocument(content);
    setShowUnsavedDialog(false);
    navigate(-1);
  };

  // Save status indicator
  const SaveStatusIndicator = () => {
    const statusConfig = {
      saved: {
        icon: CheckIcon,
        text: lastSaved ? `Saved at ${formatTime(lastSaved)}` : "Saved",
        className: "text-green-500",
      },
      saving: {
        icon: Loader2Icon,
        text: "Saving...",
        className: "text-muted-foreground animate-spin",
      },
      unsaved: {
        icon: CloudIcon,
        text: "Unsaved changes",
        className: "text-yellow-500",
      },
      error: {
        icon: AlertCircleIcon,
        text: saveError ?? "Save failed",
        className: "text-destructive",
      },
    };

    const { icon: Icon, text, className } = statusConfig[saveStatus];

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 text-sm">
              <Icon className={`size-4 ${className}`} />
              <span className="hidden text-muted-foreground sm:inline">
                {saveStatus === "saved" && lastSaved
                  ? formatTime(lastSaved)
                  : text}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p>{text}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  // Loading state
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader className="text-primary" size={32} />
          <p className="text-muted-foreground">Loading document...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error || !doc) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <AlertCircleIcon className="size-12 text-destructive" />
          <h2 className="font-semibold text-xl">Failed to load document</h2>
          <p className="text-muted-foreground">{error ?? "Unknown error"}</p>
          <Button onClick={() => navigate(-1)} variant="outline">
            <ArrowLeftIcon className="mr-2 size-4" />
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Toolbar */}
      <header className="glass shrink-0 border-border/50 border-b">
        <div className="flex items-center gap-3 px-4 py-2">
          {/* Back button */}
          <Button
            className="gap-1.5"
            onClick={handleClose}
            size="sm"
            variant="ghost"
          >
            <ArrowLeftIcon className="size-4" />
            <span className="hidden sm:inline">Back</span>
          </Button>

          <Separator className="h-5" orientation="vertical" />

          {/* Document info */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <PenIcon className="size-4 shrink-0 text-muted-foreground" />
            <h1 className="truncate font-medium">{doc.title || doc.relPath}</h1>
            {hasUnsavedChanges && (
              <Badge
                className="shrink-0 bg-yellow-500/20 text-yellow-500"
                variant="outline"
              >
                Unsaved
              </Badge>
            )}
          </div>

          {/* Save status */}
          <SaveStatusIndicator />

          <Separator className="h-5" orientation="vertical" />

          {/* Preview toggle */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={() => setShowPreview(!showPreview)}
                  size="sm"
                  variant={showPreview ? "secondary" : "ghost"}
                >
                  {showPreview ? (
                    <EyeIcon className="size-4" />
                  ) : (
                    <EyeOffIcon className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{showPreview ? "Hide preview" : "Show preview"}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* Sync scroll toggle (only show when preview is visible) */}
          {showPreview && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={
                      syncScroll ? "Disable scroll sync" : "Enable scroll sync"
                    }
                    className="transition-all duration-200"
                    onClick={() => setSyncScroll(!syncScroll)}
                    size="sm"
                    variant={syncScroll ? "secondary" : "ghost"}
                  >
                    {syncScroll ? (
                      <LinkIcon className="size-4" />
                    ) : (
                      <UnlinkIcon className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>
                    {syncScroll ? "Disable scroll sync" : "Enable scroll sync"}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Save button */}
          <Button
            disabled={!hasUnsavedChanges || saveStatus === "saving"}
            onClick={handleForceSave}
            size="sm"
          >
            {saveStatus === "saving" ? (
              <Loader2Icon className="mr-1.5 size-4 animate-spin" />
            ) : (
              <CloudIcon className="mr-1.5 size-4" />
            )}
            Save
          </Button>
        </div>
      </header>

      {/* Editor area */}
      <div className="flex min-h-0 flex-1">
        {/* Editor pane */}
        <div
          className={`min-h-0 overflow-hidden ${showPreview ? "w-1/2 border-r border-border/40 shadow-[1px_0_3px_-1px_rgba(0,0,0,0.3)]" : "w-full"}`}
        >
          <CodeMirrorEditor
            className="h-full"
            initialContent={content}
            onChange={handleContentChange}
            onScroll={
              syncScroll && showPreview ? handleEditorScroll : undefined
            }
            ref={editorRef}
          />
        </div>

        {/* Preview pane */}
        {showPreview && (
          <div
            className="w-1/2 min-h-0 overflow-auto bg-background px-8 py-6"
            onScroll={handlePreviewScroll}
            ref={previewRef}
          >
            <div className="mx-auto max-w-3xl">
              <MarkdownPreview content={content} />
            </div>
          </div>
        )}
      </div>

      {/* Unsaved changes dialog */}
      <Dialog onOpenChange={setShowUnsavedDialog} open={showUnsavedDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes. What would you like to do?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              onClick={() => setShowUnsavedDialog(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button onClick={handleDiscardAndClose} variant="destructive">
              Discard
            </Button>
            <Button onClick={handleSaveAndClose}>Save & Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
