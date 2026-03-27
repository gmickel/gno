import {
  ArrowLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  HomeIcon,
  RefreshCw,
  StarIcon,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import { Loader } from "../components/ai-elements/loader";
import { IndexingProgress } from "../components/IndexingProgress";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { apiFetch } from "../hooks/use-api";
import { useDocEvents } from "../hooks/use-doc-events";
import {
  loadFavoriteCollections,
  loadFavoriteDocuments,
  toggleFavoriteCollection,
  toggleFavoriteDocument,
} from "../lib/navigation-state";

interface PageProps {
  navigate: (to: string | number) => void;
}

interface Collection {
  name: string;
  path: string;
}

interface Document {
  docid: string;
  uri: string;
  title: string | null;
  collection: string;
  relPath: string;
  sourceExt: string;
}

interface DocsResponse {
  documents: Document[];
  total: number;
  limit: number;
  offset: number;
  availableDateFields: string[];
  sortField: string;
  sortOrder: "asc" | "desc";
}

interface SyncResponse {
  jobId: string;
}

type SyncTarget = { kind: "all" } | { kind: "collection"; name: string } | null;

export default function Browse({ navigate }: PageProps) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [docs, setDocs] = useState<Document[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const [availableDateFields, setAvailableDateFields] = useState<string[]>([]);
  const [sortField, setSortField] = useState("modified");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [syncTarget, setSyncTarget] = useState<SyncTarget>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [favoriteDocHrefs, setFavoriteDocHrefs] = useState<string[]>([]);
  const [favoriteCollections, setFavoriteCollections] = useState<string[]>([]);
  const latestDocEvent = useDocEvents();
  const limit = 25;

  // Parse collection from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const collection = params.get("collection");
    if (collection) {
      setSelected(collection);
    }
  }, []);

  useEffect(() => {
    void apiFetch<Collection[]>("/api/collections").then(({ data }) => {
      if (data) {
        setCollections(data);
      }
    });
    setFavoriteDocHrefs(loadFavoriteDocuments().map((entry) => entry.href));
    setFavoriteCollections(
      loadFavoriteCollections().map((entry) => entry.name)
    );
  }, []);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      sortField,
      sortOrder,
    });
    if (selected) {
      params.set("collection", selected);
    }
    const url = `/api/docs?${params.toString()}`;

    void apiFetch<DocsResponse>(url).then(({ data }) => {
      setLoading(false);
      setInitialLoad(false);
      if (data) {
        setAvailableDateFields(data.availableDateFields ?? []);
        setSortField(data.sortField);
        setSortOrder(data.sortOrder);
        setDocs((prev) =>
          offset === 0 ? data.documents : [...prev, ...data.documents]
        );
        setTotal(data.total);
      }
    });
  }, [selected, offset, refreshToken, sortField, sortOrder]);

  useEffect(() => {
    if (sortField === "modified" || availableDateFields.includes(sortField)) {
      return;
    }
    setSortField("modified");
    setSortOrder("desc");
    setOffset(0);
    setDocs([]);
  }, [availableDateFields, sortField]);

  useEffect(() => {
    if (!latestDocEvent?.changedAt) {
      return;
    }
    setOffset(0);
    setDocs([]);
    setRefreshToken((current) => current + 1);
  }, [latestDocEvent?.changedAt]);

  const handleCollectionChange = (value: string) => {
    const newSelected = value === "all" ? "" : value;
    setSelected(newSelected);
    setOffset(0);
    setDocs([]);
    // Update URL for shareable deep-links
    const url = newSelected
      ? `/browse?collection=${encodeURIComponent(newSelected)}`
      : "/browse";
    window.history.pushState({}, "", url);
  };

  const handleLoadMore = () => {
    setOffset((prev) => prev + limit);
  };

  const handleSortChange = (value: string) => {
    const [nextField, nextOrder] = value.split(":");
    if (!nextField || (nextOrder !== "asc" && nextOrder !== "desc")) {
      return;
    }
    setSortField(nextField);
    setSortOrder(nextOrder);
    setOffset(0);
    setDocs([]);
  };

  const navigateToCollection = (collection: string) => {
    const nextValue = collection.trim();
    if (!nextValue) {
      return;
    }
    setSelected(nextValue);
    setOffset(0);
    setDocs([]);
    window.history.pushState(
      {},
      "",
      `/browse?collection=${encodeURIComponent(nextValue)}`
    );
  };

  const handleReindex = async () => {
    setSyncError(null);

    const body = selected ? { collection: selected } : {};
    const { data, error } = await apiFetch<SyncResponse>("/api/sync", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (error) {
      setSyncError(error);
      return;
    }

    if (data?.jobId) {
      setSyncJobId(data.jobId);
      setSyncTarget(
        selected ? { kind: "collection", name: selected } : { kind: "all" }
      );
    }
  };

  const formatDateFieldLabel = (field: string) =>
    field
      .split("_")
      .filter((token) => token.length > 0)
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
      .join(" ");

  const getExtBadgeVariant = (ext: string) => {
    switch (ext.toLowerCase()) {
      case ".md":
      case ".markdown":
        return "default";
      case ".pdf":
        return "destructive";
      case ".docx":
      case ".doc":
        return "secondary";
      default:
        return "outline";
    }
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="glass sticky top-0 z-10 border-border/50 border-b">
        <div className="flex flex-wrap items-center justify-between gap-4 px-8 py-4">
          <div className="flex items-center gap-4">
            <Button
              className="gap-2 text-primary"
              onClick={() => navigate("/")}
              size="sm"
              variant="ghost"
            >
              <HomeIcon className="size-4" />
              GNO
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
            <h1 className="font-semibold text-xl">Browse</h1>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Select
              onValueChange={handleCollectionChange}
              value={selected || "all"}
            >
              <SelectTrigger className="w-[200px]">
                <FolderOpen className="mr-2 size-4 text-muted-foreground" />
                <SelectValue placeholder="All Collections" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Collections</SelectItem>
                {collections.map((c) => (
                  <SelectItem key={c.name} value={c.name}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              onValueChange={handleSortChange}
              value={`${sortField}:${sortOrder}`}
            >
              <SelectTrigger className="w-[230px]">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="modified:desc">Newest Modified</SelectItem>
                <SelectItem value="modified:asc">Oldest Modified</SelectItem>
                {availableDateFields.map((field) => (
                  <Fragment key={field}>
                    <SelectItem value={`${field}:desc`}>
                      {`Newest by ${formatDateFieldLabel(field)}`}
                    </SelectItem>
                    <SelectItem value={`${field}:asc`}>
                      {`Oldest by ${formatDateFieldLabel(field)}`}
                    </SelectItem>
                  </Fragment>
                ))}
              </SelectContent>
            </Select>
            <Badge className="font-mono" variant="outline">
              {total.toLocaleString()} docs
            </Badge>
            <Button
              className="gap-2"
              onClick={() => navigate("/collections")}
              size="sm"
              variant="outline"
            >
              <FolderOpen className="size-4" />
              Collections
            </Button>
            {selected && (
              <Button
                className="gap-2"
                onClick={() =>
                  setFavoriteCollections(
                    toggleFavoriteCollection({
                      name: selected,
                      href: `/browse?collection=${encodeURIComponent(selected)}`,
                      label: selected,
                    }).map((entry) => entry.name)
                  )
                }
                size="sm"
                variant="outline"
              >
                <StarIcon
                  className={`size-4 ${
                    favoriteCollections.includes(selected)
                      ? "fill-current text-secondary"
                      : ""
                  }`}
                />
                {favoriteCollections.includes(selected) ? "Pinned" : "Pin"}
              </Button>
            )}
            <Button
              className="gap-2"
              disabled={Boolean(syncJobId)}
              onClick={() => void handleReindex()}
              size="sm"
            >
              <RefreshCw className="size-4" />
              {selected ? "Re-index This Collection" : "Re-index All"}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-8">
        <div className="mb-6 rounded-2xl border border-border/60 bg-card/70 p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="font-medium text-sm tracking-[0.18em] uppercase">
                Collection Controls
              </p>
              <p className="max-w-2xl text-muted-foreground text-sm">
                Add folders, remove sources, and re-index after external edits
                from the collections view.
              </p>
              {selected && (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-sm">
                    Current collection:
                  </span>
                  <Badge className="font-mono text-xs" variant="secondary">
                    {selected}
                  </Badge>
                </div>
              )}
            </div>

            <div className="flex min-h-9 items-center">
              {syncJobId ? (
                <IndexingProgress
                  className="justify-end"
                  compact
                  jobId={syncJobId}
                  onComplete={() => {
                    setSyncError(null);
                    setSyncJobId(null);
                    setSyncTarget(null);
                    setRefreshToken((current) => current + 1);
                  }}
                  onError={(error) => {
                    setSyncError(error);
                    setSyncJobId(null);
                    setSyncTarget(null);
                  }}
                />
              ) : syncError ? (
                <p className="text-destructive text-sm">{syncError}</p>
              ) : syncTarget ? (
                <p className="text-muted-foreground text-sm">
                  Re-index queued for{" "}
                  <span className="font-medium text-foreground">
                    {syncTarget.kind === "all"
                      ? "all collections"
                      : syncTarget.name}
                  </span>
                  .
                </p>
              ) : null}
            </div>
          </div>
        </div>

        {/* Initial loading */}
        {initialLoad && loading && (
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <Loader className="text-primary" size={32} />
            <p className="text-muted-foreground">Loading documents...</p>
          </div>
        )}

        {/* Empty state */}
        {!loading && docs.length === 0 && (
          <div className="py-20 text-center">
            <FileText className="mx-auto mb-4 size-12 text-muted-foreground" />
            <h3 className="mb-2 font-medium text-lg">No documents found</h3>
            <p className="text-muted-foreground">
              {selected
                ? "This collection is empty"
                : "Index some documents to get started"}
            </p>
          </div>
        )}

        {/* Document Table */}
        {docs.length > 0 && (
          <div className="animate-fade-in opacity-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[50%]">Document</TableHead>
                  <TableHead>Collection</TableHead>
                  <TableHead className="text-right">Type</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.map((doc, _i) => (
                  <TableRow
                    className="group cursor-pointer"
                    key={doc.docid}
                    onClick={() =>
                      navigate(`/doc?uri=${encodeURIComponent(doc.uri)}`)
                    }
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="truncate font-medium transition-colors group-hover:text-primary">
                            {doc.title || doc.relPath}
                          </div>
                          <div className="truncate font-mono text-muted-foreground text-xs">
                            {doc.relPath}
                          </div>
                        </div>
                        <Button
                          onClick={(event) => {
                            event.stopPropagation();
                            const next = toggleFavoriteDocument({
                              uri: doc.uri,
                              href: `/doc?uri=${encodeURIComponent(doc.uri)}`,
                              label: doc.title || doc.relPath,
                            });
                            setFavoriteDocHrefs(
                              next.map((entry) => entry.href)
                            );
                          }}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <StarIcon
                            className={`size-4 ${
                              favoriteDocHrefs.includes(
                                `/doc?uri=${encodeURIComponent(doc.uri)}`
                              )
                                ? "fill-current text-secondary"
                                : "text-muted-foreground"
                            }`}
                          />
                        </Button>
                        <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className="cursor-pointer font-mono text-xs transition-colors hover:border-primary hover:text-primary"
                        onClick={(event) => {
                          event.stopPropagation();
                          navigateToCollection(doc.collection);
                        }}
                        variant="outline"
                      >
                        {doc.collection}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        className="font-mono text-xs"
                        variant={getExtBadgeVariant(doc.sourceExt)}
                      >
                        {doc.sourceExt}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* Load More */}
            {offset + limit < total && (
              <div className="mt-8 text-center">
                <Button
                  className="gap-2"
                  disabled={loading}
                  onClick={handleLoadMore}
                  variant="outline"
                >
                  {loading ? (
                    <>
                      <Loader size={16} />
                      Loading...
                    </>
                  ) : (
                    <>
                      Load More
                      <Badge className="ml-1" variant="secondary">
                        {Math.min(limit, total - docs.length)} remaining
                      </Badge>
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
