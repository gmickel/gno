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
  BookOpenIcon,
  CheckIcon,
  CloudIcon,
  EyeIcon,
  EyeOffIcon,
  HomeIcon,
  LinkIcon,
  Loader2Icon,
  PenIcon,
  SquareArrowOutUpRightIcon,
  UnlinkIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Loader } from "../components/ai-elements/loader";
import {
  CodeMirrorEditor,
  type CodeMirrorEditorRef,
  MarkdownPreview,
} from "../components/editor";
import {
  FrontmatterDisplay,
  parseFrontmatter,
} from "../components/FrontmatterDisplay";
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
import { useDocEvents } from "../hooks/use-doc-events";
import { buildEditDeepLink, parseDocumentDeepLink } from "../lib/deep-links";

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
    absPath?: string;
    mime: string;
    ext: string;
    modifiedAt?: string;
    sizeBytes?: number;
    sourceHash?: string;
  };
  capabilities: {
    editable: boolean;
    tagsEditable: boolean;
    tagsWriteback: boolean;
    canCreateEditableCopy: boolean;
    mode: "editable" | "read_only";
    reason?: string;
  };
}

interface CreateEditableCopyResponse {
  uri: string;
  path: string;
  jobId: string | null;
  note?: string;
}

interface UpdateDocResponse {
  success: boolean;
  docId: string;
  uri: string;
  path: string;
  jobId: string | null;
  writeBack?: "applied" | "skipped_unsupported";
  version: {
    sourceHash: string;
    modifiedAt?: string;
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
  const currentTarget = useMemo(
    () => parseDocumentDeepLink(window.location.search),
    []
  );
  const [doc, setDoc] = useState<DocData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [creatingCopy, setCreatingCopy] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [externalChangeNotice, setExternalChangeNotice] = useState<
    string | null
  >(null);

  const [showPreview, setShowPreview] = useState(true);
  const [syncScroll, setSyncScroll] = useState(true);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  /** Where to navigate after dialog action (-1 for back, or URL string) */
  const [pendingNavigation, setPendingNavigation] = useState<
    string | number | null
  >(null);
  const editorRef = useRef<CodeMirrorEditorRef>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // Event-based suppression: ignore the echo event caused by programmatic scroll
  const ignoreNextEditorScroll = useRef(false);
  const ignoreNextPreviewScroll = useRef(false);
  const ignoreDocEventsUntilRef = useRef(0);
  const latestDocEvent = useDocEvents();

  const hasUnsavedChanges = content !== originalContent;
  const parsedContent = useMemo(() => parseFrontmatter(content), [content]);
  const hasFrontmatter = Object.keys(parsedContent.data).length > 0;

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

      const { data, error: err } = await apiFetch<UpdateDocResponse>(
        `/api/docs/${encodeURIComponent(doc.docid)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            content: contentToSave,
            expectedSourceHash: doc.source.sourceHash,
            expectedModifiedAt: doc.source.modifiedAt,
          }),
        }
      );

      if (err) {
        setSaveStatus("error");
        setSaveError(err);
      } else {
        ignoreDocEventsUntilRef.current = Date.now() + 5_000;
        setSaveStatus("saved");
        setOriginalContent(contentToSave);
        setLastSaved(new Date());
        if (data) {
          setDoc((currentDoc) =>
            currentDoc
              ? {
                  ...currentDoc,
                  source: {
                    ...currentDoc.source,
                    sourceHash: data.version.sourceHash,
                    modifiedAt: data.version.modifiedAt,
                  },
                }
              : currentDoc
          );
        }
      }
    },
    [doc]
  );

  const handleCreateEditableCopy = useCallback(async () => {
    if (!doc?.capabilities.canCreateEditableCopy) return;

    setCreatingCopy(true);
    setCopyError(null);
    const { data, error: err } = await apiFetch<CreateEditableCopyResponse>(
      `/api/docs/${encodeURIComponent(doc.docid)}/editable-copy`,
      { method: "POST" }
    );
    setCreatingCopy(false);

    if (err) {
      setCopyError(err);
      return;
    }

    if (data) {
      ignoreDocEventsUntilRef.current = Date.now() + 5_000;
      navigate(`/edit?uri=${encodeURIComponent(data.uri)}`);
    }
  }, [doc, navigate]);

  // Debounced auto-save
  const { debouncedFn: debouncedSave } = useDebouncedCallback(
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

  // Force save (Cmd+S) - saves and triggers embedding
  const handleForceSave = useCallback(async () => {
    if (!hasUnsavedChanges || !doc) return;

    setSaveStatus("saving");
    setSaveError(null);

    // Save document
    const { data, error: err } = await apiFetch<UpdateDocResponse>(
      `/api/docs/${encodeURIComponent(doc.docid)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          content,
          expectedSourceHash: doc.source.sourceHash,
          expectedModifiedAt: doc.source.modifiedAt,
        }),
      }
    );

    if (err) {
      setSaveStatus("error");
      setSaveError(err);
      return;
    }

    ignoreDocEventsUntilRef.current = Date.now() + 5_000;
    setSaveStatus("saved");
    setOriginalContent(content);
    setLastSaved(new Date());
    if (data) {
      setDoc({
        ...doc,
        source: {
          ...doc.source,
          sourceHash: data.version.sourceHash,
          modifiedAt: data.version.modifiedAt,
        },
      });
    }

    // Trigger embedding (fire and forget - don't block on result)
    void apiFetch("/api/embed", { method: "POST" });
  }, [hasUnsavedChanges, doc, content]);

  const loadDocument = useCallback(() => {
    const uri = currentTarget.uri;

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
            if (currentTarget.lineStart) {
              editorRef.current?.revealLine(currentTarget.lineStart);
            }
          });
        }
      }
    );
  }, [currentTarget.lineStart, currentTarget.uri]);

  // Load document
  useEffect(() => {
    loadDocument();
  }, [loadDocument]);

  useEffect(() => {
    if (!doc || latestDocEvent?.uri !== doc.uri) {
      return;
    }
    if (Date.now() < ignoreDocEventsUntilRef.current) {
      return;
    }
    setExternalChangeNotice(
      "This document changed on disk. Reload before continuing."
    );
  }, [doc, latestDocEvent?.changedAt, latestDocEvent?.uri]);

  const reloadDocument = useCallback(() => {
    setExternalChangeNotice(null);
    loadDocument();
  }, [loadDocument]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;

      // Cmd+S / Ctrl+S - Save
      if (isMeta && e.key === "s") {
        e.preventDefault();
        void handleForceSave();
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

  // Handle close/back - goes to browser history
  const handleClose = () => {
    if (hasUnsavedChanges) {
      setPendingNavigation(-1);
      setShowUnsavedDialog(true);
    } else {
      navigate(-1);
    }
  };

  // Handle view doc - goes to doc view page
  const handleViewDoc = () => {
    const viewUrl = `/doc?uri=${encodeURIComponent(doc?.uri ?? "")}`;
    if (hasUnsavedChanges) {
      setPendingNavigation(viewUrl);
      setShowUnsavedDialog(true);
    } else {
      navigate(viewUrl);
    }
  };

  // Discard and navigate
  const handleDiscardAndNavigate = () => {
    setShowUnsavedDialog(false);
    if (pendingNavigation !== null) {
      navigate(pendingNavigation);
      setPendingNavigation(null);
    }
  };

  // Save and navigate
  const handleSaveAndNavigate = async () => {
    await saveDocument(content);
    // Trigger embedding (fire and forget)
    void apiFetch("/api/embed", { method: "POST" });
    setShowUnsavedDialog(false);
    if (pendingNavigation !== null) {
      navigate(pendingNavigation);
      setPendingNavigation(null);
    }
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

  if (!doc.capabilities.editable) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-xl rounded-lg border border-border/50 bg-card p-6">
          <div className="mb-4 flex items-center gap-3">
            <AlertCircleIcon className="size-8 text-amber-500" />
            <div>
              <h2 className="font-semibold text-xl">Read-only document</h2>
              <p className="text-muted-foreground text-sm">
                {doc.capabilities.reason ??
                  "This document cannot be edited in place."}
              </p>
            </div>
          </div>

          {copyError && (
            <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-amber-500 text-sm">
              {copyError}
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            {doc.capabilities.canCreateEditableCopy && (
              <Button
                disabled={creatingCopy}
                onClick={() => {
                  void handleCreateEditableCopy();
                }}
              >
                {creatingCopy ? (
                  <Loader2Icon className="mr-2 size-4 animate-spin" />
                ) : (
                  <PenIcon className="mr-2 size-4" />
                )}
                Create editable copy
              </Button>
            )}
            <Button
              onClick={() =>
                navigate(`/doc?uri=${encodeURIComponent(doc.uri)}`)
              }
              variant="outline"
            >
              <BookOpenIcon className="mr-2 size-4" />
              View document
            </Button>
            {doc.source.absPath && (
              <Button asChild variant="outline">
                <a
                  href={`file://${doc.source.absPath}`}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <SquareArrowOutUpRightIcon className="mr-2 size-4" />
                  Open original
                </a>
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Toolbar */}
      <header className="glass shrink-0 border-border/50 border-b">
        <div className="flex items-center gap-3 px-4 py-2">
          {/* Home button - Scholarly Dusk brass accent */}
          <Button
            aria-label="Go to dashboard"
            className="size-8 p-0 text-[#d4a053] hover:bg-[#d4a053]/10 hover:text-[#d4a053]"
            onClick={() => navigate("/")}
            size="sm"
            variant="ghost"
          >
            <HomeIcon className="size-4" />
          </Button>

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

          {/* View document (exit edit mode) */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Exit edit mode and view document"
                  className="gap-1.5 border-[#d4a053]/30 text-[#4db8a8] hover:border-[#d4a053]/50 hover:bg-[#4db8a8]/10 hover:text-[#4db8a8]"
                  onClick={handleViewDoc}
                  size="sm"
                  variant="outline"
                >
                  <BookOpenIcon className="size-4" />
                  <span className="hidden sm:inline">View</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Exit edit mode</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <Separator className="h-5" orientation="vertical" />

          {/* Document info */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <PenIcon className="size-4 shrink-0 text-muted-foreground" />
            <h1 className="truncate font-medium">{doc.title || doc.relPath}</h1>
            {currentTarget.lineStart && (
              <Badge className="shrink-0 font-mono" variant="outline">
                L{currentTarget.lineStart}
                {currentTarget.lineEnd &&
                currentTarget.lineEnd !== currentTarget.lineStart
                  ? `-${currentTarget.lineEnd}`
                  : ""}
              </Badge>
            )}
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

          <Button
            onClick={() => {
              void navigator.clipboard.writeText(
                `${window.location.origin}${buildEditDeepLink({
                  uri: doc.uri,
                  lineStart: currentTarget.lineStart,
                  lineEnd: currentTarget.lineEnd,
                })}`
              );
            }}
            size="sm"
            variant="ghost"
          >
            <LinkIcon className="size-4" />
          </Button>

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

      {externalChangeNotice && (
        <div className="border-amber-500/30 border-b bg-amber-500/10 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-amber-500 text-sm">{externalChangeNotice}</p>
            <Button onClick={reloadDocument} size="sm" variant="outline">
              Reload
            </Button>
          </div>
        </div>
      )}

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
              {hasFrontmatter && (
                <FrontmatterDisplay
                  className="mb-4 rounded-lg border border-border/40 bg-muted/10 p-4"
                  content={content}
                />
              )}
              <MarkdownPreview content={parsedContent.body} />
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
              onClick={() => {
                setShowUnsavedDialog(false);
                setPendingNavigation(null);
              }}
              variant="outline"
            >
              Cancel
            </Button>
            <Button onClick={handleDiscardAndNavigate} variant="destructive">
              Discard
            </Button>
            <Button onClick={handleSaveAndNavigate}>Save & Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
