import {
  AlertTriangleIcon,
  CpuIcon,
  Loader2Icon,
  RotateCcwIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../hooks/use-api";
import { Badge } from "./ui/badge";
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

function sourceBadgeVariant(source: ModelSource): "outline" | "secondary" {
  return source === "override" ? "secondary" : "outline";
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
      <DialogContent className="max-w-4xl border-border/40 bg-gradient-to-br from-background to-muted/10 p-0 shadow-[0_30px_90px_-35px_rgba(0,0,0,0.8)]">
        <DialogHeader className="border-border/30 border-b px-6 py-5 text-left">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  className="font-mono uppercase tracking-[0.12em]"
                  variant="outline"
                >
                  Collection models
                </Badge>
                <Badge className="font-mono" variant="outline">
                  preset: {collection?.activePresetId ?? "unknown"}
                </Badge>
              </div>
              <DialogTitle className="font-[Iowan_Old_Style,Palatino_Linotype,Palatino,Book_Antiqua,Georgia,serif] text-2xl">
                {collection?.name ?? "Collection"}
              </DialogTitle>
              <DialogDescription className="max-w-3xl text-muted-foreground">
                Override model roles for one collection without changing the
                active preset for the rest of the workspace.
              </DialogDescription>
            </div>
            <div className="hidden min-w-[240px] space-y-2 border-border/20 border-l pl-4 lg:block">
              <p className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-[0.15em]">
                Path
              </p>
              <p className="break-all font-mono text-[11px] text-muted-foreground/80">
                {collection?.path}
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-0">
          {MODEL_ROLES.map((role) => {
            const source = collection?.modelSources?.[role] ?? "preset";
            const effectiveValue = collection?.effectiveModels?.[role] ?? "";
            const draftValue = draft[role];

            return (
              <div
                className="grid gap-4 border-border/20 border-t px-6 py-5 lg:grid-cols-[220px_minmax(0,1fr)]"
                key={role}
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <CpuIcon className="size-4 text-secondary" />
                    <h3 className="font-medium text-sm">{ROLE_LABELS[role]}</h3>
                  </div>
                  <p className="text-muted-foreground text-sm">
                    {ROLE_NOTES[role]}
                  </p>
                </div>

                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      className="font-mono uppercase tracking-[0.12em]"
                      variant={sourceBadgeVariant(source)}
                    >
                      {source === "override" ? "override" : "inherits"}
                    </Badge>
                    <span className="font-mono text-[11px] text-muted-foreground/70 uppercase tracking-[0.15em]">
                      effective
                    </span>
                    <span className="break-all font-mono text-[11px] text-foreground/85">
                      {effectiveValue}
                    </span>
                  </div>

                  {role === "embed" && showCodeRecommendation ? (
                    <div className="rounded-lg border border-secondary/25 bg-secondary/8 px-4 py-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-1">
                          <p className="font-mono text-[10px] text-secondary uppercase tracking-[0.15em]">
                            Recommended for code collections
                          </p>
                          <p className="text-sm text-muted-foreground">
                            Benchmark-backed code recommendation. Keep the
                            active preset for prose collections; use Qwen on
                            code-heavy trees.
                          </p>
                          <p className="break-all font-mono text-[11px] text-foreground/85">
                            {CODE_EMBED_RECOMMENDATION}
                          </p>
                        </div>
                        <Button
                          className="shrink-0"
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              embed: CODE_EMBED_RECOMMENDATION,
                            }))
                          }
                          size="sm"
                          variant="secondary"
                        >
                          Apply recommendation
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      className="font-mono text-[12px]"
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
                      className="shrink-0"
                      disabled={draftValue.trim().length === 0}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          [role]: "",
                        }))
                      }
                      size="sm"
                      variant="outline"
                    >
                      <RotateCcwIcon className="size-4" />
                      Reset
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="space-y-3 border-border/30 border-t px-6 py-5">
          {collection && embedChanged && collection.documentCount > 0 ? (
            <div className="rounded-lg border border-secondary/30 bg-secondary/10 px-4 py-3 text-sm">
              <div className="flex items-start gap-2">
                <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-secondary" />
                <div className="space-y-1">
                  <p className="font-medium text-secondary">
                    Embedding change requires follow-up work
                  </p>
                  <p className="text-muted-foreground">
                    This collection already has {collection.documentCount}{" "}
                    documents and {collection.chunkCount} chunks. After saving,
                    re-index or run embeddings for this collection so vector
                    search catches up to the new embedding model.
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive text-sm">
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter className="border-border/30 border-t px-6 py-4">
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!hasChanges || saving}
            onClick={() => void handleSave()}
          >
            {saving ? <Loader2Icon className="size-4 animate-spin" /> : null}
            Save model settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
