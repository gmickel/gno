import {
  AlertTriangleIcon,
  ArrowLeft,
  Calendar,
  CheckIcon,
  ChevronRightIcon,
  CodeIcon,
  CopyIcon,
  FileText,
  FolderOpen,
  HardDrive,
  HomeIcon,
  LinkIcon,
  Loader2Icon,
  PencilIcon,
  QuoteIcon,
  Share2Icon,
  SquareArrowOutUpRightIcon,
  TextIcon,
  TrashIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { PdfFallbackReason } from "../lib/pdf";

import { extractSections } from "../../../core/sections";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "../components/ai-elements/code-block";
import { Loader } from "../components/ai-elements/loader";
import { BacklinksPanel } from "../components/BacklinksPanel";
import { MarkdownPreview } from "../components/editor";
import {
  FrontmatterDisplay,
  parseFrontmatter,
} from "../components/FrontmatterDisplay";
import {
  OutgoingLinksPanel,
  type OutgoingLink,
} from "../components/OutgoingLinksPanel";
import { RelatedNotesSidebar } from "../components/RelatedNotesSidebar";
import { TagInput } from "../components/TagInput";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Separator } from "../components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { apiFetch } from "../hooks/use-api";
import { useDocEvents } from "../hooks/use-doc-events";
import {
  buildDocDeepLink,
  buildEditDeepLink,
  parseDocumentDeepLink,
} from "../lib/deep-links";
import {
  buildDocAssetUrl,
  isExtractedTextAvailable,
  isPdfDocument,
} from "../lib/doc-asset-url";
import { waitForDocumentAvailability } from "../lib/document-availability";
import {
  downloadPublishArtifactFile,
  type PublishExportResponse,
} from "../lib/publish-export";
import {
  buildReadableSectionUrl,
  createCitationSectionUrl,
  readSectionTargetLinkParam,
  resolveSectionLinkNavigation,
  SECTION_LINK_NOTICE_COPY,
  stripSectionTargetLinkParam,
  type SectionLinkNoticeKind,
} from "../lib/section-links";
import { subscribeWorkspaceActionRequest } from "../lib/workspace-events";

/** Lazy so pdfjs is never pulled for non-PDF documents. */
const PdfViewer = lazy(() => import("./doc-pdf-viewer"));

/** Spec "Canonical fallback-notice copy" — DocView Text branch only. */
const PDF_FALLBACK_NOTICE: Record<
  PdfFallbackReason,
  { eyebrow: string; body: string }
> = {
  corrupt: {
    eyebrow: "CANNOT RENDER",
    body: "This PDF could not be rendered. View the extracted text or download the original.",
  },
  password: {
    eyebrow: "PASSWORD PROTECTED",
    body: "This PDF is password protected. Showing the extracted text instead. Download the original to open it in a PDF reader.",
  },
  network: {
    eyebrow: "COULD NOT LOAD",
    body: "The document could not be loaded from this session. Showing the extracted text instead. Switch to Pages to try again, or download the original.",
  },
  bootstrap: {
    eyebrow: "VIEWER UNAVAILABLE",
    body: "The PDF viewer could not start in this window. Showing the extracted text instead. Download the original to read it.",
  },
};

function PdfFallbackNotice({
  reason,
  downloadUrl,
}: {
  reason: PdfFallbackReason;
  downloadUrl: string;
}) {
  const copy = PDF_FALLBACK_NOTICE[reason];
  return (
    <div
      className="mb-4 flex max-w-2xl flex-col items-start gap-2 py-2 text-left"
      data-testid={`pdf-fallback-${reason}`}
      role="status"
    >
      <p className="font-mono text-[10px] text-muted-foreground/60 uppercase tracking-[0.15em]">
        {copy.eyebrow}
      </p>
      <p className="text-[13px] text-foreground/90 leading-relaxed">
        {copy.body}
      </p>
      <Button
        asChild
        className="cursor-pointer focus-visible:ring-primary/50"
        data-testid="pdf-notice-download"
        size="sm"
        variant="secondary"
      >
        <a download href={downloadUrl || undefined}>
          Download original
        </a>
      </Button>
    </div>
  );
}

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
  tags: string[];
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

interface RenameDocResponse {
  success: boolean;
  uri: string;
  path: string;
  relPath: string;
  refactorWarnings?: {
    warnings: string[];
  };
}

interface MoveDocResponse {
  success: boolean;
  uri: string;
  path: string;
  relPath: string;
  refactorWarnings?: {
    warnings: string[];
  };
}

interface DuplicateDocResponse {
  success: boolean;
  uri: string;
  path: string;
  relPath: string;
  refactorWarnings?: {
    warnings: string[];
  };
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
    if (!part) {
      continue;
    }
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

function getParentPath(relPath: string): string {
  const parts = relPath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export default function DocView({ navigate }: PageProps) {
  const [doc, setDoc] = useState<DocData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameWarnings, setRenameWarnings] = useState<string[]>([]);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moveFolderPath, setMoveFolderPath] = useState("");
  const [moveName, setMoveName] = useState("");
  const [moveWarnings, setMoveWarnings] = useState<string[]>([]);
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [duplicateFolderPath, setDuplicateFolderPath] = useState("");
  const [duplicateName, setDuplicateName] = useState("");
  const [duplicateWarnings, setDuplicateWarnings] = useState<string[]>([]);
  const [showRawView, setShowRawView] = useState(false);
  /** DocView-owned PDF fallback reason (null when Pages or no fallback). */
  const [pdfFallbackReason, setPdfFallbackReason] =
    useState<PdfFallbackReason | null>(null);
  const [creatingCopy, setCreatingCopy] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [externalChangeNotice, setExternalChangeNotice] = useState<
    string | null
  >(null);
  const [exportingPublishArtifact, setExportingPublishArtifact] =
    useState(false);
  const [publishExportError, setPublishExportError] = useState<string | null>(
    null
  );

  // Tag editing state
  const [editingTags, setEditingTags] = useState(false);
  const [editedTags, setEditedTags] = useState<string[]>([]);
  const [savingTags, setSavingTags] = useState(false);
  const [tagSaveError, setTagSaveError] = useState<string | null>(null);
  const [tagSaveSuccess, setTagSaveSuccess] = useState(false);
  const [resolvedWikiLinks, setResolvedWikiLinks] = useState<OutgoingLink[]>(
    []
  );
  const [activeSectionAnchor, setActiveSectionAnchor] = useState<string | null>(
    null
  );
  const [sectionLinkNotice, setSectionLinkNotice] =
    useState<SectionLinkNoticeKind | null>(null);
  const [blockHashNavigation, setBlockHashNavigation] = useState(false);

  // Request sequencing - ignore stale responses on rapid navigation
  const requestIdRef = useRef(0);
  const sectionResolveRequestRef = useRef(0);
  const latestDocEvent = useDocEvents();

  // App remounts page on route/query changes, so URI is stable per render.
  const currentTarget = useMemo(
    () => parseDocumentDeepLink(window.location.search),
    []
  );
  const currentUri = currentTarget.uri;
  const currentHash = useMemo(
    () => window.location.hash.replace(/^#/u, ""),
    []
  );
  const encodedSectionTarget = useMemo(
    () => readSectionTargetLinkParam(window.location.search),
    []
  );
  const highlightedLines = useMemo(() => {
    if (!currentTarget.lineStart) return [];
    const end = currentTarget.lineEnd ?? currentTarget.lineStart;
    const lines: number[] = [];
    for (let line = currentTarget.lineStart; line <= end; line += 1) {
      lines.push(line);
    }
    return lines;
  }, [currentTarget.lineEnd, currentTarget.lineStart]);

  const loadDocument = useCallback(() => {
    if (!currentUri) {
      setError("No document URI provided");
      setLoading(false);
      return;
    }

    const currentRequestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setDoc(null);
    setEditingTags(false);
    setTagSaveSuccess(false);

    void apiFetch<DocData>(
      `/api/doc?uri=${encodeURIComponent(currentUri)}`
    ).then(({ data, error: fetchError }) => {
      // Ignore stale response if newer request was made
      if (currentRequestId !== requestIdRef.current) {
        return;
      }
      setLoading(false);
      if (fetchError) {
        setError(fetchError);
      } else if (data) {
        setDoc(data);
      }
    });
  }, [currentUri]);

  // Fetch document when URI changes
  useEffect(() => {
    loadDocument();
  }, [loadDocument]);

  useEffect(() => {
    if (!doc?.docid) {
      setResolvedWikiLinks([]);
      return;
    }

    void apiFetch<{ links: OutgoingLink[] }>(
      `/api/doc/${encodeURIComponent(doc.docid)}/links?type=wiki`
    ).then(({ data }) => {
      setResolvedWikiLinks(data?.links ?? []);
    });
  }, [doc?.docid]);

  useEffect(() => {
    if (latestDocEvent?.uri !== currentUri) {
      return;
    }
    setExternalChangeNotice(
      "This document changed on disk. Reload to see the latest content."
    );
  }, [currentUri, latestDocEvent?.changedAt, latestDocEvent?.uri]);

  const reloadDocument = useCallback(() => {
    setExternalChangeNotice(null);
    loadDocument();
  }, [loadDocument]);

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

  const isPdf = Boolean(doc && isPdfDocument(doc.source));

  // Spec predicate — evaluated per render, never from mime/ext.
  const extractedTextAvailable = Boolean(doc && isExtractedTextAvailable(doc));

  const pdfAssetUrl = useMemo(() => {
    if (!doc || !isPdf) {
      return null;
    }
    return buildDocAssetUrl(doc.uri, doc.relPath);
  }, [doc, isPdf]);

  // Parse frontmatter for markdown files
  const parsedContent = useMemo(() => {
    if (!doc?.content || !isMarkdown) {
      return { data: {}, body: doc?.content ?? "" };
    }
    return parseFrontmatter(doc.content);
  }, [doc?.content, isMarkdown]);

  const hasFrontmatter = Object.keys(parsedContent.data).length > 0;
  const showStandaloneTags = !hasFrontmatter || editingTags;

  useEffect(() => {
    if (currentTarget.view === "source" || currentTarget.lineStart) {
      setShowRawView(true);
    }
  }, [currentTarget.lineStart, currentTarget.view]);

  // Clear fallback when the loaded document identity changes.
  useEffect(() => {
    setPdfFallbackReason(null);
  }, [doc?.uri]);

  /**
   * DocView defends the extractedTextAvailable boundary itself: a spurious
   * onFallback while the predicate is false must not switch view or store a
   * reason (viewer/error surface stays mounted).
   */
  const handlePdfFallback = useCallback(
    (reason: PdfFallbackReason) => {
      // Re-evaluate from current doc identity — never trust a stale closure alone.
      if (!doc || !isExtractedTextAvailable(doc)) {
        return;
      }
      setPdfFallbackReason(reason);
      setShowRawView(true);
    },
    [doc]
  );

  /** Pages/Text for PDFs — clearing notice when returning to Pages. */
  const togglePdfPagesText = useCallback(() => {
    setShowRawView((prev) => {
      if (prev) {
        setPdfFallbackReason(null);
        return false;
      }
      return true;
    });
  }, []);

  useEffect(() => {
    if (!sectionLinkNotice) {
      return;
    }
    const timer = window.setTimeout(() => setSectionLinkNotice(null), 3200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [sectionLinkNotice]);

  useEffect(() => {
    if (!doc?.content || loading || !encodedSectionTarget) {
      return;
    }

    const requestId = ++sectionResolveRequestRef.current;
    const content = doc.content;
    void resolveSectionLinkNavigation({
      content,
      uri: doc.uri,
      encodedTarget: encodedSectionTarget,
      hashAnchor: currentHash,
    }).then((result) => {
      if (requestId !== sectionResolveRequestRef.current) {
        return;
      }
      setBlockHashNavigation(result.blockHashNavigation);
      if (result.notice) {
        setSectionLinkNotice(result.notice);
      }
      if (result.cleanCitationParam) {
        const cleanedSearch = stripSectionTargetLinkParam(
          window.location.search
        );
        const nextHash = result.navigateAnchor
          ? `#${result.navigateAnchor}`
          : window.location.hash;
        window.history.replaceState(
          {},
          "",
          `${window.location.pathname}${cleanedSearch}${nextHash}`
        );
      }
      if (result.blockHashNavigation || !result.navigateAnchor) {
        return;
      }
      if (showRawView) {
        return;
      }
      requestAnimationFrame(() => {
        document
          .getElementById(result.navigateAnchor ?? "")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
        setActiveSectionAnchor(result.navigateAnchor);
      });
    });
  }, [
    currentHash,
    doc?.content,
    doc?.uri,
    encodedSectionTarget,
    loading,
    showRawView,
  ]);

  useEffect(() => {
    if (
      blockHashNavigation ||
      encodedSectionTarget ||
      !currentHash ||
      showRawView ||
      loading
    ) {
      return;
    }

    requestAnimationFrame(() => {
      document
        .getElementById(currentHash)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveSectionAnchor(currentHash);
    });
  }, [
    blockHashNavigation,
    currentHash,
    encodedSectionTarget,
    loading,
    showRawView,
  ]);

  const breadcrumbs = doc ? parseBreadcrumbs(doc.collection, doc.relPath) : [];
  const sections = useMemo(
    () => extractSections(parsedContent.body),
    [parsedContent.body]
  );

  const copyReadableSectionLink = useCallback(
    (anchor: string) => {
      if (!doc) {
        return;
      }
      void navigator.clipboard
        .writeText(
          buildReadableSectionUrl(window.location.origin, {
            uri: doc.uri,
            view: "rendered",
            anchor,
          })
        )
        .then(() => {
          setSectionLinkNotice("copied_link");
        })
        .catch(() => {
          setSectionLinkNotice("clipboard_unavailable");
        });
    },
    [doc]
  );

  const copyCitationSectionLink = useCallback(
    async (anchor: string) => {
      const content = doc?.content;
      if (!doc || !content) {
        return;
      }
      const citationUrl = await createCitationSectionUrl({
        origin: window.location.origin,
        uri: doc.uri,
        content,
        anchor,
        view: "rendered",
      });
      if (!citationUrl) {
        setSectionLinkNotice("citation_unavailable");
        return;
      }
      try {
        await navigator.clipboard.writeText(citationUrl);
        setSectionLinkNotice("copied_citation");
      } catch {
        setSectionLinkNotice("clipboard_unavailable");
      }
    },
    [doc]
  );

  const jumpToSection = useCallback(
    (anchor: string) => {
      setShowRawView(false);
      setBlockHashNavigation(false);
      requestAnimationFrame(() => {
        document.getElementById(anchor)?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
        window.history.replaceState(
          {},
          "",
          `${buildDocDeepLink({
            uri: doc?.uri ?? "",
            view: "rendered",
          })}#${anchor}`
        );
        setActiveSectionAnchor(anchor);
      });
    },
    [doc?.uri]
  );

  useEffect(() => {
    if (showRawView || sections.length === 0) {
      setActiveSectionAnchor(sections[0]?.anchor ?? null);
      return;
    }

    const updateActiveSection = () => {
      let current = sections[0]?.anchor ?? null;
      for (const section of sections) {
        const element = document.getElementById(section.anchor);
        if (!element) {
          continue;
        }
        if (element.getBoundingClientRect().top <= 160) {
          current = section.anchor;
        }
      }
      setActiveSectionAnchor(current);
    };

    updateActiveSection();
    window.addEventListener("scroll", updateActiveSection, { passive: true });
    return () => {
      window.removeEventListener("scroll", updateActiveSection);
    };
  }, [sections, showRawView]);

  const handleEdit = () => {
    if (doc?.capabilities.editable) {
      navigate(
        buildEditDeepLink({
          uri: doc.uri,
          lineStart: currentTarget.lineStart,
          lineEnd: currentTarget.lineEnd,
        })
      );
    }
  };

  const handleCreateEditableCopy = useCallback(async () => {
    if (!doc?.capabilities.canCreateEditableCopy) return;

    setCreatingCopy(true);
    setCopyError(null);
    const { data, error: err } = await apiFetch<CreateEditableCopyResponse>(
      `/api/docs/${encodeURIComponent(doc.docid)}/editable-copy`,
      {
        method: "POST",
        body: JSON.stringify({ uri: doc.uri }),
      }
    );
    setCreatingCopy(false);

    if (err) {
      setCopyError(err);
      return;
    }

    if (data) {
      const ready = await waitForDocumentAvailability(data.uri);
      if (!ready) {
        setCopyError(
          "Created the markdown copy, but it is still indexing. Try again in a moment."
        );
        return;
      }
      navigate(`/edit?uri=${encodeURIComponent(data.uri)}`);
    }
  }, [doc, navigate]);

  const handlePublishExport = useCallback(async () => {
    if (!doc) {
      return;
    }

    setPublishExportError(null);
    setExportingPublishArtifact(true);
    const { data, error: err } = await apiFetch<PublishExportResponse>(
      "/api/publish/export",
      {
        body: JSON.stringify({ target: doc.uri }),
        method: "POST",
      }
    );
    setExportingPublishArtifact(false);

    if (err) {
      setPublishExportError(err);
      return;
    }

    if (data) {
      downloadPublishArtifactFile(data);
    }
  }, [doc]);

  const handleDelete = async () => {
    if (!doc) return;

    setDeleting(true);
    setDeleteError(null);

    const endpoint = doc.capabilities.editable
      ? `/api/docs/${encodeURIComponent(doc.docid)}/trash?uri=${encodeURIComponent(doc.uri)}`
      : `/api/docs/${encodeURIComponent(doc.docid)}/deactivate?uri=${encodeURIComponent(doc.uri)}`;
    const { error: err } = await apiFetch(endpoint, { method: "POST" });

    setDeleting(false);

    if (err) {
      setDeleteError(err);
      return;
    }

    setDeleteDialogOpen(false);
    navigate(-1);
  };

  const handleStartRename = useCallback(() => {
    if (!doc) {
      return;
    }
    const filename = doc.relPath.split("/").pop() ?? doc.relPath;
    setRenameValue(filename);
    setRenameError(null);
    setRenameWarnings([]);
    setRenameDialogOpen(true);
  }, [doc]);

  useEffect(() => {
    if (!renameDialogOpen || !doc || !renameValue.trim()) {
      return;
    }
    void apiFetch<{ refactorWarnings?: { warnings: string[] } }>(
      `/api/docs/${encodeURIComponent(doc.docid)}/refactor-plan`,
      {
        method: "POST",
        body: JSON.stringify({
          operation: "rename",
          name: renameValue,
          uri: doc.uri,
        }),
      }
    ).then(({ data }) => {
      setRenameWarnings(data?.refactorWarnings?.warnings ?? []);
    });
  }, [doc, renameDialogOpen, renameValue]);

  const handleRename = useCallback(async () => {
    if (!doc) {
      return;
    }
    setRenaming(true);
    setRenameError(null);
    const { data, error: err } = await apiFetch<RenameDocResponse>(
      `/api/docs/${encodeURIComponent(doc.docid)}/rename`,
      {
        method: "POST",
        body: JSON.stringify({ name: renameValue, uri: doc.uri }),
      }
    );
    setRenaming(false);

    if (err) {
      setRenameError(err);
      return;
    }

    setRenameDialogOpen(false);
    if (data?.uri) {
      navigate(`/doc?uri=${encodeURIComponent(data.uri)}`);
    }
  }, [doc, navigate, renameValue]);

  const handleStartMove = useCallback(() => {
    if (!doc) {
      return;
    }
    setMoveFolderPath(getParentPath(doc.relPath));
    setMoveName(doc.relPath.split("/").pop() ?? doc.relPath);
    setMoveError(null);
    setMoveWarnings([]);
    setMoveDialogOpen(true);
  }, [doc]);

  useEffect(() => {
    if (!moveDialogOpen || !doc || !moveFolderPath.trim()) {
      return;
    }
    void apiFetch<{ refactorWarnings?: { warnings: string[] } }>(
      `/api/docs/${encodeURIComponent(doc.docid)}/refactor-plan`,
      {
        method: "POST",
        body: JSON.stringify({
          operation: "move",
          folderPath: moveFolderPath,
          name: moveName,
          uri: doc.uri,
        }),
      }
    ).then(({ data }) => {
      setMoveWarnings(data?.refactorWarnings?.warnings ?? []);
    });
  }, [doc, moveDialogOpen, moveFolderPath, moveName]);

  const handleMove = useCallback(async () => {
    if (!doc) {
      return;
    }
    setMoving(true);
    setMoveError(null);
    const { data, error: err } = await apiFetch<MoveDocResponse>(
      `/api/docs/${encodeURIComponent(doc.docid)}/move`,
      {
        method: "POST",
        body: JSON.stringify({
          folderPath: moveFolderPath,
          name: moveName,
          uri: doc.uri,
        }),
      }
    );
    setMoving(false);

    if (err) {
      setMoveError(err);
      return;
    }

    setMoveDialogOpen(false);
    if (data?.uri) {
      navigate(`/doc?uri=${encodeURIComponent(data.uri)}`);
    }
  }, [doc, moveFolderPath, moveName, navigate]);

  const handleStartDuplicate = useCallback(() => {
    if (!doc) {
      return;
    }
    setDuplicateFolderPath(getParentPath(doc.relPath));
    setDuplicateName(doc.relPath.split("/").pop() ?? doc.relPath);
    setDuplicateError(null);
    setDuplicateWarnings([]);
    setDuplicateDialogOpen(true);
  }, [doc]);

  useEffect(() => {
    if (!duplicateDialogOpen || !doc) {
      return;
    }
    void apiFetch<{ refactorWarnings?: { warnings: string[] } }>(
      `/api/docs/${encodeURIComponent(doc.docid)}/refactor-plan`,
      {
        method: "POST",
        body: JSON.stringify({
          operation: "duplicate",
          folderPath: duplicateFolderPath || undefined,
          name: duplicateName || undefined,
          uri: doc.uri,
        }),
      }
    ).then(({ data }) => {
      setDuplicateWarnings(data?.refactorWarnings?.warnings ?? []);
    });
  }, [doc, duplicateDialogOpen, duplicateFolderPath, duplicateName]);

  const handleDuplicate = useCallback(async () => {
    if (!doc) {
      return;
    }
    setDuplicating(true);
    setDuplicateError(null);
    const { data, error: err } = await apiFetch<DuplicateDocResponse>(
      `/api/docs/${encodeURIComponent(doc.docid)}/duplicate`,
      {
        method: "POST",
        body: JSON.stringify({
          folderPath: duplicateFolderPath || undefined,
          name: duplicateName || undefined,
          uri: doc.uri,
        }),
      }
    );
    setDuplicating(false);

    if (err) {
      setDuplicateError(err);
      return;
    }

    setDuplicateDialogOpen(false);
    if (data?.uri) {
      navigate(`/doc?uri=${encodeURIComponent(data.uri)}`);
    }
  }, [doc, duplicateFolderPath, duplicateName, navigate]);

  useEffect(() => {
    const unsubscribers = [
      subscribeWorkspaceActionRequest("rename-current-note", () => {
        if (doc?.capabilities.editable) {
          handleStartRename();
        }
      }),
      subscribeWorkspaceActionRequest("move-current-note", () => {
        if (doc?.capabilities.editable) {
          handleStartMove();
        }
      }),
      subscribeWorkspaceActionRequest("duplicate-current-note", () => {
        if (doc?.capabilities.editable) {
          handleStartDuplicate();
        }
      }),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [
    doc?.capabilities.editable,
    handleStartDuplicate,
    handleStartMove,
    handleStartRename,
  ]);

  const handleReveal = useCallback(async () => {
    if (!doc) {
      return;
    }
    const { error: err } = await apiFetch(
      `/api/docs/${encodeURIComponent(doc.docid)}/reveal?uri=${encodeURIComponent(doc.uri)}`,
      { method: "POST" }
    );
    if (err) {
      setDeleteError(err);
    }
  }, [doc]);

  // Start editing tags
  const handleStartEditTags = useCallback(() => {
    if (doc) {
      setEditedTags([...doc.tags]);
      setEditingTags(true);
      setTagSaveError(null);
      setTagSaveSuccess(false);
    }
  }, [doc]);

  // Cancel editing tags
  const handleCancelEditTags = useCallback(() => {
    setEditingTags(false);
    setEditedTags([]);
    setTagSaveError(null);
  }, []);

  // Save tags
  const handleSaveTags = useCallback(async () => {
    if (!doc) return;

    setSavingTags(true);
    setTagSaveError(null);
    setTagSaveSuccess(false);

    const { data, error: err } = await apiFetch<UpdateDocResponse>(
      `/api/docs/${encodeURIComponent(doc.docid)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          tags: editedTags,
          expectedSourceHash: doc.source.sourceHash,
          expectedModifiedAt: doc.source.modifiedAt,
          uri: doc.uri,
        }),
      }
    );

    setSavingTags(false);

    if (err) {
      setTagSaveError(err);
      return;
    }

    // Update doc with new tags
    setDoc({
      ...doc,
      tags: editedTags,
      source: {
        ...doc.source,
        sourceHash: data?.version.sourceHash ?? doc.source.sourceHash,
        modifiedAt: data?.version.modifiedAt ?? doc.source.modifiedAt,
      },
    });
    setEditingTags(false);
    setTagSaveSuccess(true);

    // Clear success indicator after 2s
    setTimeout(() => setTagSaveSuccess(false), 2000);
  }, [doc, editedTags]);

  const renderPropertiesPathRail = () => (
    <nav aria-label="Document properties" className="space-y-0">
      {/* Section: Properties */}
      <div className="px-3 pb-3">
        <div className="mb-2.5 font-mono text-[10px] text-muted-foreground/50 uppercase tracking-[0.15em]">
          Properties
        </div>
        <dl className="space-y-2.5 text-[13px]">
          <div className="flex items-center gap-2">
            <FolderOpen className="size-3.5 shrink-0 text-muted-foreground/60" />
            <dt className="sr-only">Collection</dt>
            <dd className="truncate font-medium">
              {doc?.collection || "Unknown"}
            </dd>
          </div>
          {doc?.source.sizeBytes !== undefined && (
            <div className="flex items-center gap-2">
              <HardDrive className="size-3.5 shrink-0 text-muted-foreground/60" />
              <dt className="sr-only">Size</dt>
              <dd className="font-mono text-muted-foreground">
                {formatBytes(doc.source.sizeBytes)}
              </dd>
            </div>
          )}
          {doc?.source.modifiedAt && (
            <div className="flex items-center gap-2">
              <Calendar className="size-3.5 shrink-0 text-muted-foreground/60" />
              <dt className="sr-only">Modified</dt>
              <dd className="text-muted-foreground">
                {formatDate(doc.source.modifiedAt)}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* Divider */}
      <div className="mx-3 border-border/20 border-t" />

      {/* Section: Path */}
      <div className="px-3 py-3">
        <div className="mb-1.5 font-mono text-[10px] text-muted-foreground/50 uppercase tracking-[0.15em]">
          Path
        </div>
        <code className="block break-all font-mono text-[11px] leading-relaxed text-muted-foreground/70">
          {doc?.uri}
        </code>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {currentTarget.lineStart && (
            <span className="rounded bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              L{currentTarget.lineStart}
              {currentTarget.lineEnd &&
              currentTarget.lineEnd !== currentTarget.lineStart
                ? `-${currentTarget.lineEnd}`
                : ""}
            </span>
          )}
          <button
            className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/60 transition-colors hover:bg-muted/20 hover:text-muted-foreground"
            onClick={() => {
              if (!doc) return;
              void navigator.clipboard.writeText(
                `${window.location.origin}${buildDocDeepLink({
                  uri: doc.uri,
                  view:
                    currentTarget.view === "source" || currentTarget.lineStart
                      ? "source"
                      : "rendered",
                  lineStart: currentTarget.lineStart,
                  lineEnd: currentTarget.lineEnd,
                })}`
              );
            }}
            type="button"
          >
            <LinkIcon className="size-3" />
            Copy link
          </button>
        </div>
      </div>
    </nav>
  );

  /** Left rail — metadata + outline */
  const renderDocumentFactsRail = () => (
    <nav
      aria-label="Document facts"
      className="w-full min-w-0 max-w-full space-y-0 overflow-x-hidden"
    >
      {/* Frontmatter + tags */}
      {(hasFrontmatter || showStandaloneTags) && (
        <>
          <div className="px-3 py-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[10px] text-muted-foreground/50 uppercase tracking-[0.15em]">
                {hasFrontmatter ? "Metadata" : "Tags"}
              </span>
              {!editingTags && (
                <button
                  className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/40 transition-colors hover:bg-muted/20 hover:text-muted-foreground"
                  onClick={handleStartEditTags}
                  type="button"
                >
                  <PencilIcon className="size-2.5" />
                  Edit
                </button>
              )}
              {tagSaveSuccess && (
                <span className="flex items-center gap-1 text-[10px] text-green-500">
                  <CheckIcon className="size-2.5" />
                </span>
              )}
            </div>
            {hasFrontmatter && (
              <FrontmatterDisplay
                className="grid-cols-1 gap-2 sm:grid-cols-1 lg:grid-cols-1 [&>div]:rounded-none [&>div]:bg-transparent [&>div]:p-0 [&>div]:border-b [&>div]:border-border/10 [&>div]:pb-2 [&>div:last-child]:border-0 [&>div:last-child]:pb-0 [&_a]:text-[11px] [&_a]:leading-snug [&_.text-sm]:text-[12px]"
                content={doc?.content ?? ""}
              />
            )}
            {editingTags ? (
              <div
                className={
                  hasFrontmatter
                    ? "mt-3 space-y-2 border-border/20 border-t pt-3"
                    : "space-y-2"
                }
              >
                <TagInput
                  aria-label="Edit document tags"
                  disabled={savingTags}
                  onChange={setEditedTags}
                  placeholder="Add tags..."
                  value={editedTags}
                />
                {tagSaveError && (
                  <p className="text-destructive text-xs">{tagSaveError}</p>
                )}
                <div className="flex items-center gap-1.5">
                  <Button
                    disabled={savingTags}
                    onClick={handleSaveTags}
                    size="sm"
                  >
                    {savingTags && (
                      <Loader2Icon className="mr-1 size-3 animate-spin" />
                    )}
                    Save
                  </Button>
                  <Button
                    disabled={savingTags}
                    onClick={handleCancelEditTags}
                    size="sm"
                    variant="outline"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              !hasFrontmatter && (
                <div className="flex flex-wrap gap-1">
                  {doc?.tags.length === 0 ? (
                    <span className="text-[11px] text-muted-foreground/40 italic">
                      No tags
                    </span>
                  ) : (
                    doc?.tags.map((tag) => (
                      <span
                        className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary/80"
                        key={tag}
                      >
                        {tag}
                      </span>
                    ))
                  )}
                </div>
              )
            )}
          </div>
        </>
      )}

      {sections.length > 0 && (
        <>
          <div className="mx-3 border-border/20 border-t" />
          <div className="px-3 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="font-mono text-[10px] text-muted-foreground/50 uppercase tracking-[0.15em]">
                Outline
              </div>
              {sectionLinkNotice && (
                <div
                  aria-live="polite"
                  className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/70"
                  role="status"
                >
                  {SECTION_LINK_NOTICE_COPY[sectionLinkNotice]}
                </div>
              )}
            </div>
            <div className="w-full min-w-0 max-w-full space-y-0.5 overflow-x-hidden">
              {sections.map((section) => (
                <div
                  className={`group relative w-full min-w-0 max-w-full overflow-hidden rounded px-1 py-0.5 ${
                    activeSectionAnchor === section.anchor
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground"
                  }`}
                  key={section.anchor}
                  style={{ paddingLeft: `${section.level * 7}px` }}
                >
                  <button
                    className="flex w-full min-w-0 max-w-full cursor-pointer items-start gap-2 overflow-hidden rounded px-1 py-0.5 pr-12 text-left text-xs transition-colors hover:bg-muted/20 hover:text-foreground"
                    onClick={() => {
                      jumpToSection(section.anchor);
                    }}
                    type="button"
                  >
                    <ChevronRightIcon className="size-3 shrink-0" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="min-w-0 max-w-full flex-1 overflow-hidden">
                          <span className="line-clamp-2 block break-words leading-snug">
                            {section.title}
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-[320px]">
                        <p className="break-words">{section.title}</p>
                      </TooltipContent>
                    </Tooltip>
                  </button>
                  <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 transition-all focus-within:opacity-100 group-hover:opacity-100">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          aria-label={`Copy link to ${section.title}`}
                          className="cursor-pointer rounded p-1 hover:bg-muted/20 hover:text-foreground"
                          onClick={() => {
                            copyReadableSectionLink(section.anchor);
                          }}
                          type="button"
                        >
                          <CopyIcon className="size-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left">Copy link</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          aria-label={`Copy local citation link to ${section.title}`}
                          className="cursor-pointer rounded p-1 hover:bg-muted/20 hover:text-foreground"
                          onClick={() => {
                            void copyCitationSectionLink(section.anchor);
                          }}
                          type="button"
                        >
                          <QuoteIcon className="size-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left">
                        Copy local citation link
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </nav>
  );

  const renderDocumentOverviewCard = () => (
    <Card>
      <CardContent className="space-y-3 py-3">
        <div className="flex items-center justify-between">
          <div className="font-semibold text-sm">Overview</div>
          <div className="flex items-center gap-2">
            {tagSaveSuccess && (
              <span className="flex items-center gap-1 text-green-500 text-xs">
                <CheckIcon className="size-3" />
                Saved
              </span>
            )}
            {(hasFrontmatter || doc?.tags.length) && !editingTags && (
              <Button
                className="gap-1 text-xs"
                onClick={handleStartEditTags}
                size="sm"
                variant="ghost"
              >
                <PencilIcon className="size-3" />
                Edit tags
              </Button>
            )}
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-3">
          <div className="rounded-lg bg-muted/15 px-3 py-2.5">
            <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground uppercase tracking-wider">
              <FolderOpen className="size-3.5" />
              Collection
            </div>
            <div className="font-medium text-sm">
              {doc?.collection || "Unknown"}
            </div>
          </div>

          {doc?.source.sizeBytes !== undefined && (
            <div className="rounded-lg bg-muted/15 px-3 py-2.5">
              <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground uppercase tracking-wider">
                <HardDrive className="size-3.5" />
                Size
              </div>
              <div className="font-medium text-sm">
                {formatBytes(doc.source.sizeBytes)}
              </div>
            </div>
          )}

          {doc?.source.modifiedAt && (
            <div className="rounded-lg bg-muted/15 px-3 py-2.5">
              <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground uppercase tracking-wider">
                <Calendar className="size-3.5" />
                Modified
              </div>
              <div className="font-medium text-sm">
                {formatDate(doc.source.modifiedAt)}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
            Path
          </div>
          <code className="block break-all font-mono text-[11px] text-muted-foreground">
            {doc?.uri}
          </code>
          <div className="flex flex-wrap gap-2 pt-1">
            {currentTarget.lineStart && (
              <Badge className="font-mono" variant="outline">
                L{currentTarget.lineStart}
                {currentTarget.lineEnd &&
                currentTarget.lineEnd !== currentTarget.lineStart
                  ? `-${currentTarget.lineEnd}`
                  : ""}
              </Badge>
            )}
            <Button
              onClick={() => {
                if (!doc) {
                  return;
                }
                void navigator.clipboard.writeText(
                  `${window.location.origin}${buildDocDeepLink({
                    uri: doc.uri,
                    view:
                      currentTarget.view === "source" || currentTarget.lineStart
                        ? "source"
                        : "rendered",
                    lineStart: currentTarget.lineStart,
                    lineEnd: currentTarget.lineEnd,
                  })}`
                );
              }}
              size="sm"
              variant="outline"
            >
              <LinkIcon className="mr-1.5 size-4" />
              Copy link
            </Button>
          </div>
        </div>

        {(hasFrontmatter || showStandaloneTags) && (
          <div className="rounded-lg border border-border/40 bg-muted/10 p-2.5">
            {hasFrontmatter && (
              <FrontmatterDisplay content={doc?.content ?? ""} />
            )}
            {editingTags ? (
              <div
                className={
                  hasFrontmatter
                    ? "mt-3 space-y-3 border-border/30 border-t pt-3"
                    : "space-y-3"
                }
              >
                <TagInput
                  aria-label="Edit document tags"
                  disabled={savingTags}
                  onChange={setEditedTags}
                  placeholder="Add tags..."
                  value={editedTags}
                />
                {tagSaveError && (
                  <p className="text-destructive text-xs">{tagSaveError}</p>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    disabled={savingTags}
                    onClick={handleSaveTags}
                    size="sm"
                  >
                    {savingTags && (
                      <Loader2Icon className="mr-1.5 size-3 animate-spin" />
                    )}
                    Save
                  </Button>
                  <Button
                    disabled={savingTags}
                    onClick={handleCancelEditTags}
                    size="sm"
                    variant="outline"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              !hasFrontmatter && (
                <div className="flex flex-wrap gap-1.5">
                  {doc?.tags.length === 0 ? (
                    <span className="text-muted-foreground/60 text-sm italic">
                      No tags
                    </span>
                  ) : (
                    doc?.tags.map((tag) => (
                      <Badge
                        className="font-mono text-xs"
                        key={tag}
                        variant="outline"
                      >
                        {tag}
                      </Badge>
                    ))
                  )}
                </div>
              )
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="glass sticky top-0 z-10 border-border/50 border-b">
        <div className="flex items-center gap-4 px-8 py-4">
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
          {doc?.capabilities.mode === "read_only" && (
            <Badge variant="secondary">Read-only</Badge>
          )}
          {doc?.source.ext && (
            <Badge className="shrink-0 font-mono" variant="outline">
              {doc.source.ext}
            </Badge>
          )}
          {doc && (
            <>
              <Separator className="h-6" orientation="vertical" />
              <div className="flex items-center gap-2">
                {doc.capabilities.editable ? (
                  <>
                    <Button className="gap-1.5" onClick={handleEdit} size="sm">
                      <PencilIcon className="size-4" />
                      Edit
                    </Button>
                    <Button
                      className="gap-1.5"
                      disabled={exportingPublishArtifact}
                      onClick={() => {
                        void handlePublishExport();
                      }}
                      size="sm"
                      variant="outline"
                    >
                      {exportingPublishArtifact ? (
                        <Loader2Icon className="size-4 animate-spin" />
                      ) : (
                        <Share2Icon className="size-4" />
                      )}
                      Export for gno.sh
                    </Button>
                    <Button
                      className="gap-1.5"
                      onClick={handleStartRename}
                      size="sm"
                      variant="outline"
                    >
                      <TextIcon className="size-4" />
                      Rename
                    </Button>
                    <Button
                      className="gap-1.5"
                      onClick={handleStartMove}
                      size="sm"
                      variant="outline"
                    >
                      <FolderOpen className="size-4" />
                      Move
                    </Button>
                    <Button
                      className="gap-1.5"
                      onClick={handleStartDuplicate}
                      size="sm"
                      variant="outline"
                    >
                      <CopyIcon className="size-4" />
                      Duplicate
                    </Button>
                  </>
                ) : (
                  <>
                    {doc.capabilities.canCreateEditableCopy && (
                      <Button
                        className="gap-1.5"
                        disabled={creatingCopy}
                        onClick={() => {
                          void handleCreateEditableCopy();
                        }}
                        size="sm"
                      >
                        {creatingCopy ? (
                          <Loader2Icon className="size-4 animate-spin" />
                        ) : (
                          <PencilIcon className="size-4" />
                        )}
                        Create editable copy
                      </Button>
                    )}
                    <Button
                      className="gap-1.5"
                      disabled={exportingPublishArtifact}
                      onClick={() => {
                        void handlePublishExport();
                      }}
                      size="sm"
                      variant="outline"
                    >
                      {exportingPublishArtifact ? (
                        <Loader2Icon className="size-4 animate-spin" />
                      ) : (
                        <Share2Icon className="size-4" />
                      )}
                      Export for gno.sh
                    </Button>
                    {doc.source.absPath && (
                      <>
                        <Button
                          className="gap-1.5"
                          onClick={() => {
                            void handleReveal();
                          }}
                          size="sm"
                          variant="outline"
                        >
                          <FolderOpen className="size-4" />
                          Reveal
                        </Button>
                        <Button asChild size="sm" variant="outline">
                          <a
                            href={`file://${doc.source.absPath}`}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            <SquareArrowOutUpRightIcon className="mr-1.5 size-4" />
                            Open original
                          </a>
                        </Button>
                      </>
                    )}
                  </>
                )}
                {doc.capabilities.editable && doc.source.absPath && (
                  <Button
                    className="gap-1.5"
                    onClick={() => {
                      void handleReveal();
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <FolderOpen className="size-4" />
                    Reveal
                  </Button>
                )}
                {isPdf && pdfAssetUrl ? (
                  <Button
                    asChild
                    className="gap-1.5 cursor-pointer"
                    data-testid="pdf-header-download"
                    size="sm"
                    variant="outline"
                  >
                    <a download href={pdfAssetUrl}>
                      <SquareArrowOutUpRightIcon className="size-4" />
                      Download original
                    </a>
                  </Button>
                ) : null}
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
        {publishExportError && (
          <p className="pt-2 text-destructive text-sm">{publishExportError}</p>
        )}
      </header>

      <div className="mx-auto flex max-w-[1800px] gap-5 px-6 xl:px-8">
        {/* Left rail — metadata + outline */}
        {doc && (
          <aside
            className="hidden min-w-0 flex-none border-border/15 border-r pr-2 pt-2 pb-6 lg:block"
            style={{ width: 252, minWidth: 252, maxWidth: 252, flexBasis: 252 }}
          >
            <div
              className="sticky min-w-0 max-w-full overflow-x-hidden overflow-y-auto pr-1"
              style={{ top: 72, maxHeight: "calc(100vh - 5.5rem)" }}
            >
              <div className="min-w-0 max-w-full overflow-hidden">
                {renderDocumentFactsRail()}
              </div>
            </div>
          </aside>
        )}

        {/* Main content */}
        <main className="min-w-0 flex-1 px-4 py-6">
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
            <div className="animate-fade-in space-y-4 opacity-0">
              {externalChangeNotice && (
                <Card className="border-amber-500/40 bg-amber-500/10">
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <p className="text-amber-500 text-sm">
                      {externalChangeNotice}
                    </p>
                    <Button
                      onClick={reloadDocument}
                      size="sm"
                      variant="outline"
                    >
                      Reload
                    </Button>
                  </CardContent>
                </Card>
              )}
              {copyError && (
                <Card className="border-amber-500/40 bg-amber-500/10">
                  <CardContent className="py-3 text-amber-500 text-sm">
                    {copyError}
                  </CardContent>
                </Card>
              )}
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
                          className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground hover:underline"
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

              <div className="lg:hidden">{renderDocumentOverviewCard()}</div>

              {/* Content */}
              <div className="relative">
                {/* Markdown Source/Rendered pill — unchanged for non-PDF */}
                {isMarkdown && doc.contentAvailable && !isPdf && (
                  <button
                    className="z-10 flex cursor-pointer items-center gap-1.5 rounded-full border border-border/30 bg-background/80 px-3 py-1 font-mono text-[11px] text-muted-foreground backdrop-blur-sm transition-colors hover:border-primary/30 hover:text-primary"
                    onClick={() => setShowRawView(!showRawView)}
                    style={{
                      position: "absolute",
                      top: "0.75rem",
                      right: "0.75rem",
                      left: "auto",
                    }}
                    type="button"
                  >
                    {showRawView ? (
                      <>
                        <TextIcon className="size-3" />
                        Rendered
                      </>
                    ) : (
                      <>
                        <CodeIcon className="size-3" />
                        Source
                      </>
                    )}
                  </button>
                )}

                {/* PDF Pages/Text pill — DocView sole owner (no PdfToolbar toggle) */}
                {isPdf && (
                  <button
                    className="z-10 flex cursor-pointer items-center gap-1.5 rounded-full border border-border/30 bg-background/80 px-3 py-1 font-mono text-[11px] text-muted-foreground backdrop-blur-sm transition-colors hover:border-primary/30 hover:text-primary"
                    data-testid="pdf-pages-text-toggle"
                    onClick={togglePdfPagesText}
                    style={{
                      position: "absolute",
                      top: "0.75rem",
                      right: "0.75rem",
                      left: "auto",
                    }}
                    type="button"
                  >
                    {showRawView ? (
                      <>
                        <FileText className="size-3" />
                        Pages
                      </>
                    ) : (
                      <>
                        <TextIcon className="size-3" />
                        Text
                      </>
                    )}
                  </button>
                )}

                {/* PDF branch: Pages = lazy PdfViewer; Text = extracted + optional notice */}
                {isPdf && !showRawView && pdfAssetUrl ? (
                  // Reserve the band the absolutely-positioned Pages/Text pill
                  // occupies (top 0.75rem + ~1.75rem tall). Without it the
                  // sticky PdfToolbar (z-10) renders after the pill (also
                  // z-10) and covers it, leaving the toggle invisible and
                  // un-clickable on every PDF that renders. Inline (like the
                  // pill's own positioning above) so the exact clearance is
                  // explicit: the pill occupies 0.75rem + ~1.75rem, and a
                  // `pt-10` utility (2.5rem) would leave it 0.14px short.
                  <div style={{ paddingTop: "2.75rem" }}>
                    <Suspense
                      fallback={
                        <div className="flex items-center gap-2 py-10 text-muted-foreground">
                          <Loader className="size-4" />
                          <span className="font-mono text-xs">
                            Loading viewer…
                          </span>
                        </div>
                      }
                    >
                      <PdfViewer
                        key={doc.uri}
                        assetUrl={pdfAssetUrl}
                        downloadUrl={pdfAssetUrl}
                        extractedTextAvailable={extractedTextAvailable}
                        onFallback={handlePdfFallback}
                      />
                    </Suspense>
                  </div>
                ) : null}

                {isPdf && showRawView ? (
                  <div className="pt-10">
                    {pdfFallbackReason && extractedTextAvailable ? (
                      <PdfFallbackNotice
                        downloadUrl={pdfAssetUrl ?? ""}
                        reason={pdfFallbackReason}
                      />
                    ) : null}
                    {!doc.contentAvailable ? (
                      <div className="rounded-lg border border-border/50 bg-muted/30 p-6 text-center">
                        <p className="text-muted-foreground">
                          Content not available (document may need re-indexing)
                        </p>
                      </div>
                    ) : null}
                    {doc.contentAvailable && !extractedTextAvailable ? (
                      <div
                        className="rounded-lg border border-border/50 bg-muted/30 p-6 text-center"
                        data-testid="pdf-no-extracted-text"
                      >
                        <p className="text-muted-foreground">
                          No extracted text for this document.
                        </p>
                        {pdfAssetUrl ? (
                          <div className="mt-3">
                            <Button
                              asChild
                              className="cursor-pointer"
                              size="sm"
                            >
                              <a download href={pdfAssetUrl}>
                                Download original
                              </a>
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {extractedTextAvailable ? (
                      <div className="rounded-lg border border-border/50 bg-muted/30 p-6">
                        <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">
                          {doc.content}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* Non-PDF branches (byte-identical behavior) */}
                {!isPdf && !doc.contentAvailable && (
                  <div className="rounded-lg border border-border/50 bg-muted/30 p-6 text-center">
                    <p className="text-muted-foreground">
                      Content not available (document may need re-indexing)
                    </p>
                  </div>
                )}
                {!isPdf &&
                  doc.contentAvailable &&
                  isMarkdown &&
                  !showRawView && (
                    <div className="rounded-lg border border-border/40 bg-gradient-to-br from-background to-muted/10 p-4 shadow-inner">
                      <MarkdownPreview
                        collection={doc.collection}
                        content={parsedContent.body}
                        docUri={doc.uri}
                        wikiLinks={resolvedWikiLinks}
                      />
                    </div>
                  )}
                {!isPdf &&
                  doc.contentAvailable &&
                  isMarkdown &&
                  showRawView && (
                    <CodeBlock
                      code={doc.content ?? ""}
                      highlightedLines={highlightedLines}
                      language={"markdown" as BundledLanguage}
                      scrollToLine={currentTarget.lineStart}
                      showLineNumbers
                    >
                      <CodeBlockCopyButton />
                    </CodeBlock>
                  )}
                {!isPdf &&
                  doc.contentAvailable &&
                  isCodeFile &&
                  !isMarkdown && (
                    <CodeBlock
                      code={doc.content ?? ""}
                      highlightedLines={highlightedLines}
                      language={
                        getLanguageFromExt(doc.source.ext) as BundledLanguage
                      }
                      scrollToLine={currentTarget.lineStart}
                      showLineNumbers
                    >
                      <CodeBlockCopyButton />
                    </CodeBlock>
                  )}
                {!isPdf && doc.contentAvailable && !isCodeFile && (
                  <div className="rounded-lg border border-border/50 bg-muted/30 p-6">
                    <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">
                      {doc.content}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>

        {/* Right rail — properties/path + relationships */}
        {doc && (
          <aside
            className="hidden min-w-0 flex-none overflow-hidden border-border/15 border-l pl-2 pt-2 pb-6 lg:block"
            style={{ width: 250, minWidth: 250, maxWidth: 250, flexBasis: 250 }}
          >
            <div
              className="sticky min-w-0 space-y-1 overflow-y-auto overflow-x-hidden pr-1"
              style={{ top: 72, maxHeight: "calc(100vh - 5.5rem)" }}
            >
              {renderPropertiesPathRail()}
              <BacklinksPanel
                docId={doc.docid}
                onNavigate={(uri) =>
                  navigate(`/doc?uri=${encodeURIComponent(uri)}`)
                }
              />
              <OutgoingLinksPanel
                docId={doc.docid}
                onNavigate={(uri) =>
                  navigate(`/doc?uri=${encodeURIComponent(uri)}`)
                }
              />
              <RelatedNotesSidebar
                docId={doc.docid}
                onNavigate={(uri) =>
                  navigate(`/doc?uri=${encodeURIComponent(uri)}`)
                }
              />
            </div>
          </aside>
        )}
      </div>

      {/* Delete confirmation dialog */}
      <Dialog onOpenChange={setDeleteDialogOpen} open={deleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TrashIcon className="size-5 text-destructive" />
              {doc?.capabilities.editable
                ? "Move to Trash?"
                : "Remove from index?"}
            </DialogTitle>
            <DialogDescription className="space-y-3 pt-2">
              {doc?.capabilities.editable ? (
                <>
                  <span className="block">
                    This will move{" "}
                    <strong>"{doc?.title || doc?.relPath}"</strong> to your
                    system Trash and remove it from the current index.
                  </span>
                  <span className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-500">
                    <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                    <span className="text-sm">
                      This is reversible through Trash. GNO will stop showing
                      the file after the current collection refresh.
                    </span>
                  </span>
                </>
              ) : (
                <>
                  <span className="block">
                    This will remove{" "}
                    <strong>"{doc?.title || doc?.relPath}"</strong> from the GNO
                    search index.
                  </span>
                  <span className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-500">
                    <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                    <span className="text-sm">
                      The source file stays on disk. It may be re-indexed on the
                      next sync unless you exclude it.
                    </span>
                  </span>
                </>
              )}
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
              {doc?.capabilities.editable
                ? "Move to Trash"
                : "Remove from index"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setRenameDialogOpen} open={renameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename document</DialogTitle>
            <DialogDescription>
              Rename the file on disk inside its current folder. This does not
              move it to another collection yet.
            </DialogDescription>
          </DialogHeader>
          <input
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
            onChange={(event) => setRenameValue(event.target.value)}
            value={renameValue}
          />
          {renameError && (
            <div className="rounded-lg bg-destructive/10 p-3 text-destructive text-sm">
              {renameError}
            </div>
          )}
          {renameWarnings.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-500 text-sm">
              {renameWarnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              onClick={() => setRenameDialogOpen(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={renaming} onClick={() => void handleRename()}>
              {renaming && (
                <Loader2Icon className="mr-1.5 size-4 animate-spin" />
              )}
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setMoveDialogOpen} open={moveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move document</DialogTitle>
            <DialogDescription>
              Move the current note to another folder inside this collection.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              onChange={(event) => setMoveFolderPath(event.target.value)}
              placeholder="projects/research"
              value={moveFolderPath}
            />
            <Input
              onChange={(event) => setMoveName(event.target.value)}
              placeholder="note.md"
              value={moveName}
            />
            {moveError && (
              <div className="rounded-lg bg-destructive/10 p-3 text-destructive text-sm">
                {moveError}
              </div>
            )}
            {moveWarnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-500 text-sm">
                {moveWarnings.map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button onClick={() => setMoveDialogOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button disabled={moving} onClick={() => void handleMove()}>
              {moving && <Loader2Icon className="mr-1.5 size-4 animate-spin" />}
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setDuplicateDialogOpen} open={duplicateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Duplicate document</DialogTitle>
            <DialogDescription>
              Create a copy of this note in the current or another folder.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              onChange={(event) => setDuplicateFolderPath(event.target.value)}
              placeholder="projects/research"
              value={duplicateFolderPath}
            />
            <Input
              onChange={(event) => setDuplicateName(event.target.value)}
              placeholder="note-copy.md"
              value={duplicateName}
            />
            {duplicateError && (
              <div className="rounded-lg bg-destructive/10 p-3 text-destructive text-sm">
                {duplicateError}
              </div>
            )}
            {duplicateWarnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-500 text-sm">
                {duplicateWarnings.map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              onClick={() => setDuplicateDialogOpen(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={duplicating}
              onClick={() => void handleDuplicate()}
            >
              {duplicating && (
                <Loader2Icon className="mr-1.5 size-4 animate-spin" />
              )}
              Duplicate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
