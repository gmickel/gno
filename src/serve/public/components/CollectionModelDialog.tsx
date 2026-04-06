import {
  AlertTriangleIcon,
  CpuIcon,
  Loader2Icon,
  RotateCcwIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../hooks/use-api";
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

const MODEL_ROLES = ["embed", "rerank", "expand", "gen"] as const;

type ModelRole = (typeof MODEL_ROLES)[number];
type ModelSource = "override" | "preset" | "default";

const ROLE_LABELS: Record<ModelRole, string> = {
  embed: "Embedding",
  rerank: "Reranker",
  expand: "Query Expansion",
  gen: "Answer Model",
};

const ROLE_NOTES: Record<ModelRole, string> = {
  embed: "Drives vector search and embedding backlog for this collection.",
  rerank: "Scores candidate passages/documents after retrieval.",
  expand:
    "Generates lexical and semantic expansion variants for harder queries.",
  gen: "Used for collection-targeted answer generation flows.",
};

export interface CollectionModelDetails {
  activePresetId?: string;
  chunkCount: number;
  documentCount: number;
  effectiveModels?: Record<ModelRole, string>;
  include?: string[];
  modelSources?: Record<ModelRole, ModelSource>;
  models?: Partial<Record<ModelRole, string>>;
  name: string;
  path: string;
  pattern?: string;
}

interface UpdateCollectionResponse {
  collection: CollectionModelDetails;
  success: boolean;
}

interface CollectionModelDialogProps {
  collection: CollectionModelDetails | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  open: boolean;
}

function normalizeValue(value: string | undefined): string {
  return value?.trim() ?? "";
}

const CODE_EMBED_RECOMMENDATION =
  "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";

const CODE_PATH_HINTS = [
  "/src",
  "/lib",
  "/app",
  "/apps",
  "/packages",
  "/server",
  "/services",
] as const;

const CODE_EXT_HINTS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".go",
  ".rs",
  ".py",
  ".swift",
  ".c",
] as const;

function collectionLooksCodeHeavy(collection: CollectionModelDetails): boolean {
  const path = collection.path.toLowerCase();
  if (
    CODE_PATH_HINTS.some(
      (hint) => path.endsWith(hint) || path.includes(`${hint}/`)
    )
  ) {
    return true;
  }

  const includeValues = collection.include ?? [];
  if (
    includeValues.some((value) =>
      CODE_EXT_HINTS.some((ext) => value.includes(ext))
    )
  ) {
    return true;
  }

  const pattern = collection.pattern?.toLowerCase() ?? "";
  return CODE_EXT_HINTS.some(
    (ext) => pattern.includes(ext) || pattern.includes(ext.replace(".", ""))
  );
}

export function CollectionModelDialog({
  collection,
  onOpenChange,
  onSaved,
  open,
}: CollectionModelDialogProps) {
  const [draft, setDraft] = useState<Record<ModelRole, string>>({
    embed: "",
    rerank: "",
    expand: "",
    gen: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const showCodeRecommendation =
    collection !== null && collectionLooksCodeHeavy(collection);

  useEffect(() => {
    if (!open || !collection) {
      return;
    }

    setDraft({
      embed: collection.models?.embed ?? "",
      rerank: collection.models?.rerank ?? "",
      expand: collection.models?.expand ?? "",
      gen: collection.models?.gen ?? "",
    });
    setError(null);
    setSaving(false);
  }, [collection, open]);

  const patch = useMemo(() => {
    if (!collection) {
      return {};
    }

    const nextPatch: Partial<Record<ModelRole, string | null>> = {};
    for (const role of MODEL_ROLES) {
      const original = normalizeValue(collection.models?.[role]);
      const current = normalizeValue(draft[role]);
      if (original === current) {
        continue;
      }
      nextPatch[role] = current.length === 0 ? null : current;
    }

    return nextPatch;
  }, [collection, draft]);

  const hasChanges = Object.keys(patch).length > 0;
  const embedChanged = Object.hasOwn(patch, "embed");

  const handleSave = async () => {
    if (!collection || !hasChanges) {
      return;
    }

    setSaving(true);
    setError(null);

    const { error: requestError } = await apiFetch<UpdateCollectionResponse>(
      `/api/collections/${encodeURIComponent(collection.name)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ models: patch }),
      }
    );

    setSaving(false);

    if (requestError) {
      setError(requestError);
      return;
    }

    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col gap-0 overflow-x-hidden border-none bg-[#0f1115] p-0 shadow-[0_30px_90px_-35px_rgba(0,0,0,0.8)]">
        {/* Header */}
        <DialogHeader className="shrink-0 border-border/20 border-b px-6 pt-5 pb-4 text-left">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="rounded bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground/70 uppercase tracking-[0.12em]">
                  Collection models
                </span>
                <span className="rounded bg-muted/30 px-2 py-0.5 font-mono text-[10px] text-muted-foreground/50 tracking-[0.05em]">
                  preset: {collection?.activePresetId ?? "unknown"}
                </span>
              </div>
              <DialogTitle className="font-[Iowan_Old_Style,Palatino_Linotype,Palatino,Book_Antiqua,Georgia,serif] text-2xl leading-tight">
                {collection?.name ?? "Collection"}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground/70 text-[13px]">
                Override model roles for one collection without changing the
                active preset for the rest of the workspace.
              </DialogDescription>
            </div>
            <div className="hidden shrink-0 max-w-[200px] space-y-1 border-border/15 border-l pl-4 lg:block">
              <p className="font-mono text-[10px] text-muted-foreground/50 uppercase tracking-[0.15em]">
                Path
              </p>
              <p
                className="break-all font-mono text-[10px] leading-relaxed text-muted-foreground/50"
                title={collection?.path}
              >
                {collection?.path}
              </p>
            </div>
          </div>
        </DialogHeader>

        {/* Scrollable model roles */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="divide-y divide-border/15">
            {MODEL_ROLES.map((role) => {
              const source = collection?.modelSources?.[role] ?? "preset";
              const effectiveValue = collection?.effectiveModels?.[role] ?? "";
              const draftValue = draft[role];
              const isOverride = source === "override";

              return (
                <div
                  className="grid gap-x-5 gap-y-3 px-6 py-4 lg:grid-cols-[180px_minmax(0,1fr)]"
                  key={role}
                >
                  {/* Left: role info */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <CpuIcon className="size-3.5 text-secondary/70" />
                      <h3 className="font-medium text-[13px]">
                        {ROLE_LABELS[role]}
                      </h3>
                    </div>
                    <p className="text-muted-foreground/50 text-xs leading-relaxed">
                      {ROLE_NOTES[role]}
                    </p>
                  </div>

                  {/* Right: controls */}
                  <div className="space-y-2.5">
                    {/* Source + effective model */}
                    <div className="flex items-baseline gap-2">
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] ${
                          isOverride
                            ? "bg-secondary/15 text-secondary/80"
                            : "bg-muted/40 text-muted-foreground/50"
                        }`}
                      >
                        {isOverride ? "override" : "inherits"}
                      </span>
                      <span className="font-mono text-[9px] text-muted-foreground/35 uppercase tracking-[0.12em]">
                        effective
                      </span>
                    </div>
                    <p
                      className="break-all font-mono text-[11px] leading-relaxed text-foreground/70"
                      title={effectiveValue}
                    >
                      {effectiveValue}
                    </p>

                    {/* Code embed recommendation */}
                    {role === "embed" && showCodeRecommendation ? (
                      <button
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-secondary/15 bg-secondary/5 px-3 py-2 text-left transition-colors hover:border-secondary/25 hover:bg-secondary/8"
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            embed: CODE_EMBED_RECOMMENDATION,
                          }))
                        }
                        type="button"
                      >
                        <SparklesIcon className="size-3.5 shrink-0 text-secondary/60" />
                        <div className="min-w-0">
                          <p className="text-[11px] text-foreground/70">
                            Apply code-optimized embedding
                          </p>
                          <p className="truncate font-mono text-[10px] text-muted-foreground/40">
                            {CODE_EMBED_RECOMMENDATION}
                          </p>
                        </div>
                      </button>
                    ) : null}

                    {/* Input + reset */}
                    <div className="flex items-center gap-1.5">
                      <Input
                        className="h-8 border-border/20 bg-muted/10 font-mono text-[11px] placeholder:text-muted-foreground/25"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            [role]: event.target.value,
                          }))
                        }
                        placeholder="Leave empty to inherit from preset"
                        value={draftValue}
                      />
                      <Button
                        className="size-8 shrink-0 border-border/20 text-muted-foreground/30 hover:text-muted-foreground/60"
                        disabled={draftValue.trim().length === 0}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            [role]: "",
                          }))
                        }
                        size="icon-sm"
                        variant="outline"
                      >
                        <RotateCcwIcon className="size-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Warnings */}
          {collection && embedChanged && collection.documentCount > 0 ? (
            <div className="border-border/15 border-t px-6 py-3">
              <div className="flex items-start gap-2.5 rounded-md border border-secondary/15 bg-secondary/5 px-3 py-2.5">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-secondary/60" />
                <div>
                  <p className="font-medium text-secondary/80 text-xs">
                    Re-index needed after save
                  </p>
                  <p className="mt-0.5 text-muted-foreground/50 text-xs">
                    {collection.documentCount} docs / {collection.chunkCount}{" "}
                    chunks will need re-embedding for the new model.
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="border-border/15 border-t px-6 py-3">
              <div className="rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2.5 text-destructive text-xs">
                {error}
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer — always visible */}
        <DialogFooter className="shrink-0 border-border/20 border-t px-6 py-3">
          <Button
            className="border-border/20 text-xs"
            onClick={() => onOpenChange(false)}
            size="sm"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            className="text-xs"
            disabled={!hasChanges || saving}
            onClick={() => void handleSave()}
            size="sm"
          >
            {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            Save model settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
