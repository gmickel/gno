import {
  AlertTriangleIcon,
  ArrowLeft,
  Calendar,
  ChevronRightIcon,
  CodeIcon,
  FileText,
  FolderOpen,
  HardDrive,
  Loader2Icon,
  PencilIcon,
  TextIcon,
  TrashIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  CodeBlock,
  CodeBlockCopyButton,
} from "../components/ai-elements/code-block";
import { Loader } from "../components/ai-elements/loader";
import { MarkdownPreview } from "../components/editor";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Separator } from "../components/ui/separator";
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

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return "0 B";
  }
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

// Shiki BundledLanguage subset we actually use
// Cast is safe - all values are valid BundledLanguage
type SupportedLanguage =
  | "markdown"
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "python"
  | "rust"
  | "go"
  | "json"
  | "yaml"
  | "html"
  | "css"
  | "sql"
  | "bash"
  | "text";

// Import BundledLanguage for type assertion
import type { BundledLanguage } from "shiki";

function getLanguageFromExt(ext: string): SupportedLanguage {
  const map: Record<string, SupportedLanguage> = {
    ".md": "markdown",
    ".markdown": "markdown",
    ".js": "javascript",
    ".jsx": "jsx",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".html": "html",
    ".css": "css",
    ".sql": "sql",
    ".sh": "bash",
    ".bash": "bash",
  };
  return map[ext.toLowerCase()] || "text";
}

/** Parse breadcrumb segments from collection and relPath */
function parseBreadcrumbs(
  collection: string,
  relPath: string
): { label: string; path: string }[] {
  const segments: { label: string; path: string }[] = [
    {
      label: collection,
      path: `/browse?collection=${encodeURIComponent(collection)}`,
    },
  ];

  const parts = relPath.split("/").filter(Boolean);
  let currentPath = "";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    currentPath = currentPath ? `${currentPath}/${part}` : part;

    // Last segment is the file - no link
    if (i === parts.length - 1) {
      segments.push({ label: part, path: "" });
    } else {
      segments.push({
        label: part,
        path: `/browse?collection=${encodeURIComponent(collection)}&path=${encodeURIComponent(currentPath)}`,
      });
    }
  }

  return segments;
}

export default function DocView({ navigate }: PageProps) {
  const [doc, setDoc] = useState<DocData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showRawView, setShowRawView] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const uri = params.get("uri");

    if (!uri) {
      setError("No document URI provided");
      setLoading(false);
      return;
    }

    void apiFetch<DocData>(`/api/doc?uri=${encodeURIComponent(uri)}`).then(
      ({ data, error }) => {
        setLoading(false);
        if (error) {
          setError(error);
        } else if (data) {
          setDoc(data);
        }
      }
    );
  }, []);

  const isMarkdown =
    doc?.source.ext &&
    [".md", ".markdown"].includes(doc.source.ext.toLowerCase());

  const isCodeFile =
    doc?.source.ext &&
    [
      ".md",
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".py",
      ".rs",
      ".go",
      ".json",
      ".yaml",
      ".yml",
      ".html",
      ".css",
      ".sql",
      ".sh",
      ".bash",
    ].includes(doc.source.ext.toLowerCase());

  const breadcrumbs = doc ? parseBreadcrumbs(doc.collection, doc.relPath) : [];

  const handleEdit = () => {
    if (doc) {
      navigate(`/edit?uri=${encodeURIComponent(doc.uri)}`);
    }
  };

  const handleDelete = async () => {
    if (!doc) return;

    setDeleting(true);
    setDeleteError(null);

    const { error: err } = await apiFetch(
      `/api/docs/${encodeURIComponent(doc.docid)}/deactivate`,
      { method: "POST" }
    );

    setDeleting(false);

    if (err) {
      setDeleteError(err);
      return;
    }

    setDeleteDialogOpen(false);
    navigate(-1);
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="glass sticky top-0 z-10 border-border/50 border-b">
        <div className="flex items-center gap-4 px-8 py-4">
          <Button
            className="gap-2"
            onClick={() => navigate(-1)}
            size="sm"
            variant="ghost"
          >
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <Separator className="h-6" orientation="vertical" />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <h1 className="truncate font-semibold text-xl">
              {doc?.title || "Document"}
            </h1>
          </div>
          {doc?.source.ext && (
            <Badge className="shrink-0 font-mono" variant="outline">
              {doc.source.ext}
            </Badge>
          )}
          {doc && (
            <>
              <Separator className="h-6" orientation="vertical" />
              <div className="flex items-center gap-2">
                <Button className="gap-1.5" onClick={handleEdit} size="sm">
                  <PencilIcon className="size-4" />
                  Edit
                </Button>
                <Button
                  className="gap-1.5 text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteDialogOpen(true)}
                  size="sm"
                  variant="ghost"
                >
                  <TrashIcon className="size-4" />
                </Button>
              </div>
            </>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl p-8">
        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <Loader className="text-primary" size={32} />
            <p className="text-muted-foreground">Loading document...</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <Card className="border-destructive bg-destructive/10">
            <CardContent className="py-6 text-center">
              <FileText className="mx-auto mb-4 size-12 text-destructive" />
              <h3 className="mb-2 font-medium text-destructive text-lg">
                Failed to load document
              </h3>
              <p className="text-muted-foreground">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Document */}
        {doc && (
          <div className="animate-fade-in space-y-6 opacity-0">
            {/* Breadcrumbs */}
            {breadcrumbs.length > 0 && (
              <nav className="flex items-center gap-1 text-sm">
                <FolderOpen className="mr-1 size-4 text-muted-foreground" />
                {breadcrumbs.map((crumb, i) => (
                  <span className="flex items-center gap-1" key={crumb.label}>
                    {i > 0 && (
                      <ChevronRightIcon className="size-3 text-muted-foreground/50" />
                    )}
                    {crumb.path ? (
                      <button
                        className="text-muted-foreground transition-colors hover:text-foreground hover:underline"
                        onClick={() => navigate(crumb.path)}
                        type="button"
                      >
                        {crumb.label}
                      </button>
                    ) : (
                      <span className="font-medium text-foreground">
                        {crumb.label}
                      </span>
                    )}
                  </span>
                ))}
              </nav>
            )}

            {/* Metadata */}
            <Card>
              <CardContent className="py-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="flex items-center gap-3">
                    <FolderOpen className="size-4 text-muted-foreground" />
                    <div>
                      <div className="text-muted-foreground text-xs">
                        Collection
                      </div>
                      <div className="font-medium">
                        {doc.collection || "Unknown"}
                      </div>
                    </div>
                  </div>
                  {doc.source.sizeBytes !== undefined && (
                    <div className="flex items-center gap-3">
                      <HardDrive className="size-4 text-muted-foreground" />
                      <div>
                        <div className="text-muted-foreground text-xs">
                          Size
                        </div>
                        <div className="font-medium">
                          {formatBytes(doc.source.sizeBytes)}
                        </div>
                      </div>
                    </div>
                  )}
                  {doc.source.modifiedAt && (
                    <div className="flex items-center gap-3">
                      <Calendar className="size-4 text-muted-foreground" />
                      <div>
                        <div className="text-muted-foreground text-xs">
                          Modified
                        </div>
                        <div className="font-medium">
                          {formatDate(doc.source.modifiedAt)}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="mt-4 border-border/50 border-t pt-4">
                  <div className="mb-1 text-muted-foreground text-xs">Path</div>
                  <code className="break-all font-mono text-muted-foreground text-sm">
                    {doc.uri}
                  </code>
                </div>
              </CardContent>
            </Card>

            {/* Content */}
            <Card>
              <CardHeader className="pb-0">
                <CardTitle className="flex items-center justify-between text-lg">
                  <span className="flex items-center gap-2">
                    <FileText className="size-4" />
                    Content
                  </span>
                  {isMarkdown && doc.contentAvailable && (
                    <Button
                      className="gap-1.5"
                      onClick={() => setShowRawView(!showRawView)}
                      size="sm"
                      variant="ghost"
                    >
                      {showRawView ? (
                        <>
                          <TextIcon className="size-4" />
                          <span className="hidden sm:inline">Rendered</span>
                        </>
                      ) : (
                        <>
                          <CodeIcon className="size-4" />
                          <span className="hidden sm:inline">Source</span>
                        </>
                      )}
                    </Button>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                {!doc.contentAvailable && (
                  <div className="rounded-lg border border-border/50 bg-muted/30 p-6 text-center">
                    <p className="text-muted-foreground">
                      Content not available (document may need re-indexing)
                    </p>
                  </div>
                )}
                {doc.contentAvailable && isMarkdown && !showRawView && (
                  <div className="rounded-lg border border-border/40 bg-gradient-to-br from-background to-muted/10 p-6 shadow-inner">
                    <MarkdownPreview content={doc.content ?? ""} />
                  </div>
                )}
                {doc.contentAvailable && isMarkdown && showRawView && (
                  <CodeBlock
                    code={doc.content ?? ""}
                    language={"markdown" as BundledLanguage}
                    showLineNumbers
                  >
                    <CodeBlockCopyButton />
                  </CodeBlock>
                )}
                {doc.contentAvailable && isCodeFile && !isMarkdown && (
                  <CodeBlock
                    code={doc.content ?? ""}
                    language={
                      getLanguageFromExt(doc.source.ext) as BundledLanguage
                    }
                    showLineNumbers
                  >
                    <CodeBlockCopyButton />
                  </CodeBlock>
                )}
                {doc.contentAvailable && !isCodeFile && (
                  <div className="rounded-lg border border-border/50 bg-muted/30 p-6">
                    <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">
                      {doc.content}
                    </pre>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </main>

      {/* Delete confirmation dialog */}
      <Dialog onOpenChange={setDeleteDialogOpen} open={deleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TrashIcon className="size-5 text-destructive" />
              Remove from index?
            </DialogTitle>
            <DialogDescription className="space-y-3 pt-2">
              <span className="block">
                This will remove <strong>
                  "{doc?.title || doc?.relPath}"
                </strong>{" "}
                from the GNO search index.
              </span>
              <span className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-500">
                <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                <span className="text-sm">
                  The file will NOT be deleted from disk. It may be re-indexed
                  on next sync unless you add it to the collection's exclude
                  pattern.
                </span>
              </span>
            </DialogDescription>
          </DialogHeader>

          {deleteError && (
            <div className="rounded-lg bg-destructive/10 p-3 text-destructive text-sm">
              {deleteError}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              onClick={() => setDeleteDialogOpen(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={deleting}
              onClick={handleDelete}
              variant="destructive"
            >
              {deleting && (
                <Loader2Icon className="mr-1.5 size-4 animate-spin" />
              )}
              Remove from index
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
