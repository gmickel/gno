/**
 * AddCollectionDialog - Dialog for adding new document collections.
 *
 * Features:
 * - Path input with folder icon
 * - Auto-generates name from folder path
 * - Collapsible advanced options (pattern, exclude)
 * - Shows IndexingProgress after creation
 */

import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  FolderIcon,
  FolderPlusIcon,
  Loader2Icon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../hooks/use-api";
import { cn } from "../lib/utils";
import { IndexingProgress } from "./IndexingProgress";
import { Button } from "./ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

export interface AddCollectionDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Callback when collection created successfully */
  onSuccess?: () => void;
  /** Optional path to prefill when opening from onboarding shortcuts */
  initialPath?: string;
}

interface CreateCollectionResponse {
  collection: {
    name: string;
    path: string;
  };
  jobId: string;
}

type DialogState = "form" | "submitting" | "success" | "error";

/** Extract folder name from path */
function getFolderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts.at(-1) || "";
}

/** Validate path is absolute */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Z]:\\/.test(path);
}

export function AddCollectionDialog({
  initialPath,
  open,
  onOpenChange,
  onSuccess,
}: AddCollectionDialogProps) {
  // Form state
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("**/*.md");
  const [exclude, setExclude] = useState("node_modules/**");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Submission state
  const [state, setState] = useState<DialogState>("form");
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState<string | null>(null);

  // Auto-fill name from path
  const derivedName = name || getFolderName(path);

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      const timer = setTimeout(() => {
        setPath("");
        setName("");
        setPattern("**/*.md");
        setExclude("node_modules/**");
        setAdvancedOpen(false);
        setState("form");
        setError(null);
        setJobId(null);
        setCreatedName(null);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [open]);

  useEffect(() => {
    if (open && initialPath && state === "form") {
      setPath(initialPath);
    }
  }, [initialPath, open, state]);

  // Validation
  const pathError =
    path && !isAbsolutePath(path) ? "Path must be absolute" : null;
  const isValid = path.trim() && !pathError;

  // Submit handler
  const handleSubmit = useCallback(async () => {
    if (!isValid) return;

    setState("submitting");
    setError(null);

    const { data, error: err } = await apiFetch<CreateCollectionResponse>(
      "/api/collections",
      {
        method: "POST",
        body: JSON.stringify({
          path: path.trim(),
          name: derivedName || undefined,
          pattern: pattern.trim() || "**/*.md",
          exclude: exclude.trim() || undefined,
        }),
      }
    );

    if (err) {
      setState("error");
      setError(err);
      return;
    }

    if (data) {
      setState("success");
      setJobId(data.jobId);
      setCreatedName(data.collection.name);
    }
  }, [isValid, path, derivedName, pattern, exclude]);

  // Handle indexing complete
  const handleIndexComplete = () => {
    onSuccess?.();
    onOpenChange(false);
  };

  // Keyboard submit
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && isValid) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlusIcon className="size-5 text-primary" />
            {state === "success" ? "Collection added" : "Add collection"}
          </DialogTitle>
          {state === "form" && (
            <DialogDescription>
              Add a folder to index. Documents will be searchable immediately.
            </DialogDescription>
          )}
        </DialogHeader>

        {/* Form state */}
        {(state === "form" || state === "submitting") && (
          <div className="space-y-4 py-2">
            {/* Path input */}
            <div className="space-y-2">
              <label
                className="block font-medium text-sm"
                htmlFor="collection-path"
              >
                Folder path
              </label>
              <div className="relative">
                <FolderIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  className={cn(
                    "pl-10 font-mono text-sm",
                    pathError &&
                      "border-destructive focus-visible:ring-destructive"
                  )}
                  disabled={state === "submitting"}
                  id="collection-path"
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/Users/you/Documents/notes"
                  value={path}
                />
              </div>
              {pathError && (
                <p className="text-destructive text-xs">{pathError}</p>
              )}
              {path && !pathError && (
                <p className="text-muted-foreground text-xs">
                  Will be indexed as:{" "}
                  <span className="font-medium text-foreground">
                    {derivedName || "unnamed"}
                  </span>
                </p>
              )}
            </div>

            {/* Name override */}
            <div className="space-y-2">
              <label
                className="block font-medium text-sm"
                htmlFor="collection-name"
              >
                Name{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </label>
              <Input
                className="font-mono text-sm"
                disabled={state === "submitting"}
                id="collection-name"
                onChange={(e) => setName(e.target.value)}
                placeholder={getFolderName(path) || "my-notes"}
                value={name}
              />
            </div>

            {/* Advanced options */}
            <Collapsible onOpenChange={setAdvancedOpen} open={advancedOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  className="h-auto gap-1.5 p-0 text-muted-foreground hover:text-foreground"
                  disabled={state === "submitting"}
                  type="button"
                  variant="ghost"
                >
                  <ChevronDownIcon
                    className={cn(
                      "size-4 transition-transform duration-200",
                      advancedOpen && "rotate-180"
                    )}
                  />
                  Advanced options
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 space-y-4">
                {/* Pattern */}
                <div className="space-y-2">
                  <label
                    className="block font-medium text-sm"
                    htmlFor="collection-pattern"
                  >
                    File pattern{" "}
                    <span className="font-normal text-muted-foreground">
                      (glob)
                    </span>
                  </label>
                  <Input
                    className="font-mono text-sm"
                    disabled={state === "submitting"}
                    id="collection-pattern"
                    onChange={(e) => setPattern(e.target.value)}
                    placeholder="**/*.md"
                    value={pattern}
                  />
                  <p className="text-muted-foreground text-xs">
                    Default: <code className="text-[11px]">**/*.md</code> (all
                    markdown files)
                  </p>
                </div>

                {/* Exclude */}
                <div className="space-y-2">
                  <label
                    className="block font-medium text-sm"
                    htmlFor="collection-exclude"
                  >
                    Exclude patterns{" "}
                    <span className="font-normal text-muted-foreground">
                      (comma-separated)
                    </span>
                  </label>
                  <Input
                    className="font-mono text-sm"
                    disabled={state === "submitting"}
                    id="collection-exclude"
                    onChange={(e) => setExclude(e.target.value)}
                    placeholder="node_modules/**, .git/**"
                    value={exclude}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}

        {/* Error state */}
        {state === "error" && error && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertCircleIcon className="size-6 text-destructive" />
            </div>
            <div>
              <h3 className="font-medium text-destructive">
                Failed to add collection
              </h3>
              <p className="mt-1 max-w-xs text-muted-foreground text-sm">
                {error}
              </p>
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
                <h3 className="font-medium">
                  Collection "{createdName}" added
                </h3>
                <p className="text-muted-foreground text-sm">
                  Indexing documents...
                </p>
              </div>
            </div>

            {jobId && (
              <div className="rounded-lg border border-border/50 p-3">
                <IndexingProgress
                  compact
                  jobId={jobId}
                  onComplete={handleIndexComplete}
                />
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <DialogFooter className="gap-2 sm:gap-0">
          {(state === "form" || state === "submitting") && (
            <>
              <Button onClick={() => onOpenChange(false)} variant="outline">
                Cancel
              </Button>
              <Button
                disabled={!isValid || state === "submitting"}
                onClick={handleSubmit}
              >
                {state === "submitting" && (
                  <Loader2Icon className="mr-1.5 size-4 animate-spin" />
                )}
                {state === "submitting" ? "Adding..." : "Add collection"}
              </Button>
            </>
          )}

          {state === "success" && (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
