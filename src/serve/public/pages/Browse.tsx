import {
  ArrowLeft,
  FilePlus2,
  FolderOpen,
  HomeIcon,
  FolderPlus,
  RefreshCw,
  StarIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  createBrowseNodeId,
  findBrowseNode,
  getBrowseAncestorIds,
  getImmediateChildFolders,
} from "../../browse-tree";
import { Loader } from "../components/ai-elements/loader";
import { BrowseDetailPane } from "../components/BrowseDetailPane";
import { BrowseOverview } from "../components/BrowseOverview";
import { BrowseTreeSidebar } from "../components/BrowseTreeSidebar";
import { BrowseWorkspaceCard } from "../components/BrowseWorkspaceCard";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { apiFetch } from "../hooks/use-api";
import { useDocEvents } from "../hooks/use-doc-events";
import { useCaptureModal } from "../hooks/useCaptureModal";
import { useWorkspace } from "../hooks/useWorkspace";
import {
  buildBrowseCrumbs,
  buildBrowseLocation,
  formatDateFieldLabel,
  parseBrowseLocation,
  type BrowseDocument,
  type BrowseTreeResponse,
  type DocsResponse,
} from "../lib/browse";
import {
  loadFavoriteCollections,
  loadFavoriteDocuments,
  toggleFavoriteCollection,
  toggleFavoriteDocument,
} from "../lib/navigation-state";
import { subscribeWorkspaceActionRequest } from "../lib/workspace-events";

interface PageProps {
  navigate: (to: string | number) => void;
  location?: string;
}

interface SyncResponse {
  jobId: string;
}

interface CreateFolderResponse {
  success: boolean;
  collection: string;
  folderPath: string;
  path: string;
}

type SyncTarget = { kind: "all" } | { kind: "collection"; name: string } | null;

export default function Browse({ navigate, location }: PageProps) {
  const { activeTab, updateActiveTabBrowseState } = useWorkspace();
  const { openCapture } = useCaptureModal();
  const latestDocEvent = useDocEvents();
  const resolvedLocation =
    location ?? `${window.location.pathname}${window.location.search}`;
  const selection = useMemo(
    () =>
      parseBrowseLocation(
        resolvedLocation.includes("?")
          ? `?${resolvedLocation.split("?")[1] ?? ""}`
          : ""
      ),
    [resolvedLocation]
  );
  const [tree, setTree] = useState<BrowseTreeResponse | null>(null);
  const [docs, setDocs] = useState<BrowseDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [treeLoading, setTreeLoading] = useState(true);
  const [docsLoading, setDocsLoading] = useState(false);
  const [availableDateFields, setAvailableDateFields] = useState<string[]>([]);
  const [sortField, setSortField] = useState("modified");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const [syncTarget, setSyncTarget] = useState<SyncTarget>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [favoriteDocHrefs, setFavoriteDocHrefs] = useState<string[]>([]);
  const [favoriteCollections, setFavoriteCollections] = useState<string[]>([]);
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [createFolderName, setCreateFolderName] = useState("");
  const [createFolderError, setCreateFolderError] = useState<string | null>(
    null
  );
  const [creatingFolder, setCreatingFolder] = useState(false);
  const limit = 25;

  const selectedCollection = selection.collection;
  const selectedPath = selection.path;
  const selectedNodeId = selectedCollection
    ? createBrowseNodeId(selectedCollection, selectedPath)
    : null;
  const resolvedSelectedNode = tree
    ? findBrowseNode(tree.collections, selectedCollection, selectedPath)
    : null;
  const selectedNode =
    resolvedSelectedNode ??
    (selectedCollection
      ? {
          id:
            selectedNodeId ??
            createBrowseNodeId(selectedCollection, selectedPath),
          kind: selectedPath ? "folder" : "collection",
          collection: selectedCollection,
          path: selectedPath,
          name: selectedPath.split("/").at(-1) ?? selectedCollection,
          depth: selectedPath
            ? selectedPath.split("/").filter(Boolean).length
            : 0,
          documentCount: docs.length,
          directDocumentCount: docs.length,
          children: [],
        }
      : null);

  const expandedNodeIds = useMemo(() => {
    const persisted = activeTab?.browseState?.expandedNodeIds ?? [];
    const ancestors = selectedPath
      ? getBrowseAncestorIds(selectedCollection, selectedPath)
      : [];
    return [...new Set([...persisted, ...ancestors])];
  }, [
    activeTab?.browseState?.expandedNodeIds,
    selectedCollection,
    selectedPath,
  ]);

  const childFolders = useMemo(() => {
    if (!tree) {
      return [];
    }
    if (!selectedCollection) {
      return tree.collections;
    }
    return getImmediateChildFolders(
      tree.collections,
      selectedCollection,
      selectedPath
    );
  }, [selectedCollection, selectedPath, tree]);

  const crumbs = useMemo(
    () =>
      selectedCollection
        ? buildBrowseCrumbs(selectedCollection, selectedPath)
        : [],
    [selectedCollection, selectedPath]
  );

  useEffect(() => {
    setOffset(0);
    setDocs([]);
  }, [selectedCollection, selectedPath]);

  useEffect(() => {
    setFavoriteDocHrefs(loadFavoriteDocuments().map((entry) => entry.href));
    setFavoriteCollections(
      loadFavoriteCollections().map((entry) => entry.name)
    );
  }, []);

  useEffect(() => {
    void apiFetch<BrowseTreeResponse>("/api/browse/tree").then(({ data }) => {
      setTree(
        data ?? { collections: [], totalCollections: 0, totalDocuments: 0 }
      );
      setTreeLoading(false);
    });
  }, [refreshToken]);

  useEffect(() => {
    if (!tree) {
      return;
    }

    if (!selectedCollection) {
      return;
    }

    const node = findBrowseNode(
      tree.collections,
      selectedCollection,
      selectedPath
    );
    if (node) {
      return;
    }
    if (selectedPath) {
      return;
    }
    const collectionRoot = findBrowseNode(tree.collections, selectedCollection);
    if (collectionRoot) {
      navigate(buildBrowseLocation(selectedCollection));
      return;
    }
    navigate("/browse");
  }, [navigate, selectedCollection, selectedPath, tree]);

  useEffect(() => {
    if (!selectedCollection) {
      setDocs([]);
      setTotal(0);
      setOffset(0);
      return;
    }

    setDocsLoading(true);
    const params = new URLSearchParams({
      collection: selectedCollection,
      limit: String(limit),
      offset: String(offset),
      sortField,
      sortOrder,
      directChildrenOnly: "true",
    });
    if (selectedPath) {
      params.set("pathPrefix", selectedPath);
    }

    void apiFetch<DocsResponse>(`/api/docs?${params.toString()}`).then(
      ({ data }) => {
        setDocsLoading(false);
        if (!data) {
          return;
        }
        setAvailableDateFields(data.availableDateFields ?? []);
        setSortField(data.sortField);
        setSortOrder(data.sortOrder);
        setDocs((prev) =>
          offset === 0 ? data.documents : [...prev, ...data.documents]
        );
        setTotal(data.total);
      }
    );
  }, [
    limit,
    offset,
    refreshToken,
    selectedCollection,
    selectedPath,
    sortField,
    sortOrder,
  ]);

  useEffect(() => {
    if (!latestDocEvent?.changedAt) {
      return;
    }
    setOffset(0);
    setDocs([]);
    setRefreshToken((current) => current + 1);
  }, [latestDocEvent?.changedAt]);

  useEffect(() => {
    return subscribeWorkspaceActionRequest("create-folder-here", () => {
      if (!selectedCollection) {
        return;
      }
      setCreateFolderError(null);
      setCreateFolderOpen(true);
    });
  }, [selectedCollection]);

  useEffect(() => {
    const persisted = activeTab?.browseState?.expandedNodeIds ?? [];
    const ancestors = selectedPath
      ? getBrowseAncestorIds(selectedCollection, selectedPath)
      : [];
    const merged = [...new Set([...persisted, ...ancestors])];
    if (merged.length === persisted.length) {
      return;
    }
    updateActiveTabBrowseState({
      expandedNodeIds: merged,
    });
  }, [
    activeTab?.browseState?.expandedNodeIds,
    selectedCollection,
    selectedPath,
    updateActiveTabBrowseState,
  ]);

  const handleLoadMore = () => {
    setOffset((current) => current + limit);
  };

  const handleSelectNode = (collection: string, path?: string) => {
    setDocs([]);
    setOffset(0);
    setMobileTreeOpen(false);
    navigate(buildBrowseLocation(collection, path));
  };

  const handleToggleNode = (nodeId: string) => {
    updateActiveTabBrowseState((current) => {
      const next = new Set(current.expandedNodeIds);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return {
        expandedNodeIds: [...next],
      };
    });
  };

  const handleToggleFavoriteCollection = (collection: string) => {
    const next = toggleFavoriteCollection({
      name: collection,
      href: buildBrowseLocation(collection),
      label: collection,
    });
    setFavoriteCollections(next.map((entry) => entry.name));
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

  const handleReindex = async () => {
    setSyncError(null);
    const body = selectedCollection ? { collection: selectedCollection } : {};
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
        selectedCollection
          ? { kind: "collection", name: selectedCollection }
          : { kind: "all" }
      );
    }
  };

  const handleCreateFolder = async () => {
    if (!selectedCollection || !createFolderName.trim()) {
      return;
    }

    setCreatingFolder(true);
    setCreateFolderError(null);
    const { data, error } = await apiFetch<CreateFolderResponse>(
      "/api/folders",
      {
        method: "POST",
        body: JSON.stringify({
          collection: selectedCollection,
          parentPath: selectedPath || undefined,
          name: createFolderName.trim(),
        }),
      }
    );
    setCreatingFolder(false);

    if (error) {
      setCreateFolderError(error);
      return;
    }
    if (data?.folderPath) {
      setCreateFolderOpen(false);
      setCreateFolderName("");
      navigate(buildBrowseLocation(selectedCollection, data.folderPath));
      setRefreshToken((current) => current + 1);
    }
  };

  const renderSidebar = () => (
    <BrowseTreeSidebar
      collections={tree?.collections ?? []}
      expandedNodeIds={expandedNodeIds}
      favoriteCollections={favoriteCollections}
      onSelect={handleSelectNode}
      onToggle={handleToggleNode}
      onToggleFavoriteCollection={handleToggleFavoriteCollection}
      selectedNodeId={selectedNodeId}
    />
  );

  return (
    <div className="min-h-screen">
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
            <Button
              className="gap-2 lg:hidden"
              onClick={() => setMobileTreeOpen(true)}
              size="sm"
              variant="outline"
            >
              <FolderOpen className="size-4" />
              Tree
            </Button>
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
                  <SelectItem key={`${field}:desc`} value={`${field}:desc`}>
                    {`Newest by ${formatDateFieldLabel(field)}`}
                  </SelectItem>
                ))}
                {availableDateFields.map((field) => (
                  <SelectItem key={`${field}:asc`} value={`${field}:asc`}>
                    {`Oldest by ${formatDateFieldLabel(field)}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Badge className="font-mono" variant="outline">
              {selectedNode?.documentCount ??
                tree?.totalDocuments.toLocaleString() ??
                0}{" "}
              docs
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
            {selectedCollection && (
              <Button
                className="gap-2"
                onClick={() =>
                  openCapture({
                    defaultCollection: selectedCollection,
                    defaultFolderPath: selectedPath || undefined,
                    draftTitle: "",
                  })
                }
                size="sm"
                variant="outline"
              >
                <FilePlus2 className="size-4" />
                New Note
              </Button>
            )}
            {selectedCollection && (
              <Button
                className="gap-2"
                onClick={() => {
                  setCreateFolderOpen(true);
                  setCreateFolderError(null);
                }}
                size="sm"
                variant="outline"
              >
                <FolderPlus className="size-4" />
                New Folder
              </Button>
            )}
            {selectedCollection && (
              <Button
                className="gap-2"
                onClick={() =>
                  handleToggleFavoriteCollection(selectedCollection)
                }
                size="sm"
                variant="outline"
              >
                <StarIcon
                  className={`size-4 ${
                    favoriteCollections.includes(selectedCollection)
                      ? "fill-current text-secondary"
                      : ""
                  }`}
                />
                {favoriteCollections.includes(selectedCollection)
                  ? "Pinned"
                  : "Pin"}
              </Button>
            )}
            <Button
              className="gap-2"
              disabled={Boolean(syncJobId)}
              onClick={() => void handleReindex()}
              size="sm"
            >
              <RefreshCw className="size-4" />
              {selectedCollection ? "Re-index This Collection" : "Re-index All"}
            </Button>
          </div>
        </div>
      </header>

      <div className="flex min-h-[calc(100vh-73px)]">
        <aside className="hidden w-[320px] shrink-0 border-border/40 border-r bg-card/30 lg:block">
          {treeLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader className="text-primary" size={24} />
            </div>
          ) : (
            renderSidebar()
          )}
        </aside>

        <main className="min-w-0 flex-1 p-8">
          <div className="mx-auto max-w-6xl space-y-6">
            <BrowseWorkspaceCard
              crumbs={crumbs}
              navigate={navigate}
              onSyncComplete={() => {
                setSyncError(null);
                setSyncJobId(null);
                setSyncTarget(null);
                setRefreshToken((current) => current + 1);
              }}
              onSyncError={(error) => {
                setSyncError(error);
                setSyncJobId(null);
                setSyncTarget(null);
              }}
              selectedCollection={selectedCollection}
              syncError={syncError}
              syncJobId={syncJobId}
              syncTarget={syncTarget}
            />

            {treeLoading ? (
              <div className="flex flex-col items-center justify-center gap-4 py-20">
                <Loader className="text-primary" size={32} />
                <p className="text-muted-foreground">
                  Loading workspace tree...
                </p>
              </div>
            ) : !selectedCollection ? (
              <BrowseOverview
                collections={tree?.collections ?? []}
                favoriteCollections={favoriteCollections}
                onSelectCollection={(collection) =>
                  handleSelectNode(collection)
                }
                onToggleFavoriteCollection={handleToggleFavoriteCollection}
              />
            ) : (
              <BrowseDetailPane
                childFolders={childFolders}
                docs={docs}
                docsLoading={docsLoading}
                favoriteDocHrefs={favoriteDocHrefs}
                onLoadMore={handleLoadMore}
                onOpenDoc={(uri) =>
                  navigate(`/doc?uri=${encodeURIComponent(uri)}`)
                }
                onSelectCollection={(collection) =>
                  handleSelectNode(collection)
                }
                onSelectFolder={handleSelectNode}
                onToggleFavoriteDocument={(doc) => {
                  const next = toggleFavoriteDocument({
                    uri: doc.uri,
                    href: `/doc?uri=${encodeURIComponent(doc.uri)}`,
                    label: doc.title || doc.relPath,
                  });
                  setFavoriteDocHrefs(next.map((entry) => entry.href));
                }}
                selectedNode={selectedNode}
                selectedPath={selectedPath}
                total={total}
              />
            )}
          </div>
        </main>
      </div>

      <Dialog onOpenChange={setMobileTreeOpen} open={mobileTreeOpen}>
        <DialogContent className="max-w-xl p-0">
          <DialogHeader className="px-6 pt-6">
            <DialogTitle>Workspace Tree</DialogTitle>
          </DialogHeader>
          <div className="h-[70vh] border-border/40 border-t">
            {treeLoading ? (
              <div className="flex h-full items-center justify-center">
                <Loader className="text-primary" size={24} />
              </div>
            ) : (
              renderSidebar()
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setCreateFolderOpen} open={createFolderOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create folder</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              autoFocus
              onChange={(event) => setCreateFolderName(event.target.value)}
              placeholder="research"
              value={createFolderName}
            />
            {selectedCollection && (
              <p className="font-mono text-xs text-muted-foreground">
                {selectedCollection}
                {selectedPath ? ` / ${selectedPath}` : ""}
              </p>
            )}
            {createFolderError && (
              <p className="text-destructive text-sm">{createFolderError}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => setCreateFolderOpen(false)}
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                disabled={!createFolderName.trim() || creatingFolder}
                onClick={() => void handleCreateFolder()}
              >
                {creatingFolder ? "Creating..." : "Create Folder"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
