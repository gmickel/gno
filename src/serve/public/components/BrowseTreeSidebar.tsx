import {
  ChevronRight,
  FolderIcon,
  FolderOpenIcon,
  StarIcon,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import type { BrowseTreeNode } from "../../browse-tree";

import { cn } from "../lib/utils";
import { ScrollArea } from "./ui/scroll-area";

interface BrowseTreeSidebarProps {
  collections: BrowseTreeNode[];
  expandedNodeIds: string[];
  favoriteCollections: string[];
  selectedNodeId: string | null;
  onSelect: (collection: string, path?: string) => void;
  onToggle: (nodeId: string) => void;
  onToggleFavoriteCollection: (collection: string) => void;
}

interface VisibleBrowseNode {
  node: BrowseTreeNode;
  parentId: string | null;
}

function flattenInto(
  nodes: BrowseTreeNode[],
  expandedNodeIds: Set<string>,
  parentId: string | null,
  out: VisibleBrowseNode[]
): void {
  for (const node of nodes) {
    out.push({ node, parentId });
    if (node.children.length > 0 && expandedNodeIds.has(node.id)) {
      flattenInto(node.children, expandedNodeIds, node.id, out);
    }
  }
}

function flattenVisibleNodes(
  nodes: BrowseTreeNode[],
  expandedNodeIds: Set<string>
): VisibleBrowseNode[] {
  const flat: VisibleBrowseNode[] = [];
  flattenInto(nodes, expandedNodeIds, null, flat);
  return flat;
}

const VIRTUALIZE_THRESHOLD = 100;
const VIRTUAL_ROW_HEIGHT_PX = 36;
const VIRTUAL_OVERSCAN_ROWS = 12;

export function BrowseTreeSidebar({
  collections,
  expandedNodeIds,
  favoriteCollections,
  selectedNodeId,
  onSelect,
  onToggle,
  onToggleFavoriteCollection,
}: BrowseTreeSidebarProps) {
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(
    selectedNodeId
  );
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);
  const expandedNodeSet = useMemo(
    () => new Set(expandedNodeIds),
    [expandedNodeIds]
  );
  const favoriteCollectionSet = useMemo(
    () => new Set(favoriteCollections),
    [favoriteCollections]
  );
  const visibleNodes = useMemo(
    () => flattenVisibleNodes(collections, expandedNodeSet),
    [collections, expandedNodeSet]
  );
  const visibleIndexById = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < visibleNodes.length; i += 1) {
      map.set(visibleNodes[i]!.node.id, i);
    }
    return map;
  }, [visibleNodes]);

  useEffect(() => {
    setFocusedNodeId(selectedNodeId);
  }, [selectedNodeId]);

  const shouldVirtualize = visibleNodes.length > VIRTUALIZE_THRESHOLD;

  // Keep a deep-linked or externally selected row mounted in the virtual window
  // so keyboard users always have a reachable tab stop on the selected folder.
  useEffect(() => {
    if (!shouldVirtualize || !selectedNodeId) {
      return;
    }
    const selectedIndex = visibleIndexById.get(selectedNodeId);
    if (selectedIndex === undefined) {
      return;
    }
    const targetTop = selectedIndex * VIRTUAL_ROW_HEIGHT_PX;
    const targetBottom = targetTop + VIRTUAL_ROW_HEIGHT_PX;
    const container = treeScrollRef.current;
    const effectiveHeight = container?.clientHeight || viewportHeight;
    const currentTop = container ? container.scrollTop : scrollTop;
    if (targetTop < currentTop || targetBottom > currentTop + effectiveHeight) {
      const nextTop = Math.max(0, targetTop - Math.floor(effectiveHeight / 2));
      if (container) {
        container.scrollTop = nextTop;
      }
      setScrollTop(nextTop);
    }
  }, [selectedNodeId, shouldVirtualize, visibleIndexById, viewportHeight]);

  useEffect(() => {
    if (!shouldVirtualize) {
      return;
    }
    const container = treeScrollRef.current;
    if (!container) {
      return;
    }
    const updateViewport = () => {
      const nextHeight = container.clientHeight || 640;
      setViewportHeight(nextHeight);
    };
    updateViewport();
    const onScroll = () => {
      setScrollTop(container.scrollTop);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", updateViewport);
    return () => {
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", updateViewport);
    };
  }, [shouldVirtualize]);

  const favoriteRoots = useMemo(
    () =>
      collections.filter((node) => favoriteCollectionSet.has(node.collection)),
    [collections, favoriteCollectionSet]
  );

  const moveFocus = (nodeId: string | null) => {
    if (!nodeId) {
      return;
    }
    setFocusedNodeId(nodeId);
    if (shouldVirtualize) {
      const targetIndex = visibleIndexById.get(nodeId);
      const container = treeScrollRef.current;
      if (targetIndex !== undefined && container) {
        const targetTop = targetIndex * VIRTUAL_ROW_HEIGHT_PX;
        const targetBottom = targetTop + VIRTUAL_ROW_HEIGHT_PX;
        if (targetTop < container.scrollTop) {
          container.scrollTop = targetTop;
          setScrollTop(targetTop);
        } else if (
          targetBottom >
          container.scrollTop + container.clientHeight
        ) {
          const nextTop = Math.max(0, targetBottom - container.clientHeight);
          container.scrollTop = nextTop;
          setScrollTop(nextTop);
        }
      }
    }
    requestAnimationFrame(() => {
      nodeRefs.current.get(nodeId)?.focus();
    });
  };

  const getVisibleIndex = (nodeId: string | null) =>
    nodeId ? (visibleIndexById.get(nodeId) ?? -1) : -1;

  const startIndex = shouldVirtualize
    ? Math.max(
        0,
        Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT_PX) - VIRTUAL_OVERSCAN_ROWS
      )
    : 0;
  const endIndex = shouldVirtualize
    ? Math.min(
        visibleNodes.length,
        Math.ceil((scrollTop + viewportHeight) / VIRTUAL_ROW_HEIGHT_PX) +
          VIRTUAL_OVERSCAN_ROWS
      )
    : visibleNodes.length;
  const renderedNodes = shouldVirtualize
    ? visibleNodes.slice(startIndex, endIndex)
    : visibleNodes;
  const activeTabTarget = focusedNodeId ?? selectedNodeId;
  const activeTabTargetMounted =
    activeTabTarget !== null &&
    renderedNodes.some(({ node }) => node.id === activeTabTarget);
  const topSpacerPx = shouldVirtualize ? startIndex * VIRTUAL_ROW_HEIGHT_PX : 0;
  const bottomSpacerPx = shouldVirtualize
    ? (visibleNodes.length - endIndex) * VIRTUAL_ROW_HEIGHT_PX
    : 0;

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-4">
        {favoriteRoots.length > 0 && (
          <div className="space-y-2">
            <div className="px-2 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.2em]">
              Pinned
            </div>
            <div className="space-y-1">
              {favoriteRoots.map((node) => (
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted/50"
                  key={`pinned-${node.id}`}
                  onClick={() => onSelect(node.collection)}
                  type="button"
                >
                  <StarIcon className="size-3.5 fill-current text-secondary" />
                  <span className="truncate">{node.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <div className="px-2 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.2em]">
            Workspace Tree
          </div>
          <div
            aria-label="Browse tree"
            className={
              shouldVirtualize
                ? "max-h-[calc(100vh-14rem)] overflow-y-auto"
                : undefined
            }
            ref={treeScrollRef}
            role="tree"
          >
            {topSpacerPx > 0 && (
              <div aria-hidden="true" style={{ height: `${topSpacerPx}px` }} />
            )}
            {renderedNodes.map(({ node, parentId }, localIndex) => {
              const isExpanded = expandedNodeSet.has(node.id);
              const isSelected = node.id === selectedNodeId;
              const isFocused = node.id === focusedNodeId;
              const hasChildren = node.children.length > 0;
              const isFavorite = favoriteCollectionSet.has(node.collection);

              return (
                <Fragment key={node.id}>
                  <div
                    className={cn(
                      "group flex items-center gap-1 rounded-md pr-1 transition-colors",
                      isSelected && "bg-primary/10 text-primary"
                    )}
                  >
                    <button
                      aria-label={
                        hasChildren
                          ? `${isExpanded ? "Collapse" : "Expand"} ${node.name}`
                          : undefined
                      }
                      className={cn(
                        "ml-1 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
                        "hover:bg-muted/60 hover:text-foreground",
                        !hasChildren && "opacity-0"
                      )}
                      disabled={!hasChildren}
                      onClick={() => hasChildren && onToggle(node.id)}
                      tabIndex={-1}
                      type="button"
                    >
                      <ChevronRight
                        className={cn(
                          "size-3.5 transition-transform",
                          isExpanded && "rotate-90"
                        )}
                      />
                    </button>
                    <button
                      aria-expanded={hasChildren ? isExpanded : undefined}
                      aria-level={node.depth + 1}
                      aria-selected={isSelected}
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm outline-none transition-colors",
                        isFocused && "ring-2 ring-primary/40",
                        !isSelected && "hover:bg-muted/50"
                      )}
                      onClick={() =>
                        onSelect(node.collection, node.path || undefined)
                      }
                      onKeyDown={(event) => {
                        const currentIndex = getVisibleIndex(node.id);
                        switch (event.key) {
                          case "ArrowDown":
                            event.preventDefault();
                            moveFocus(
                              visibleNodes[currentIndex + 1]?.node.id ?? null
                            );
                            break;
                          case "ArrowUp":
                            event.preventDefault();
                            moveFocus(
                              visibleNodes[currentIndex - 1]?.node.id ?? null
                            );
                            break;
                          case "ArrowRight":
                            event.preventDefault();
                            if (hasChildren && !isExpanded) {
                              onToggle(node.id);
                            } else if (hasChildren) {
                              moveFocus(node.children[0]?.id ?? null);
                            }
                            break;
                          case "ArrowLeft":
                            event.preventDefault();
                            if (hasChildren && isExpanded) {
                              onToggle(node.id);
                            } else {
                              moveFocus(parentId);
                            }
                            break;
                          case "Home":
                            event.preventDefault();
                            moveFocus(visibleNodes[0]?.node.id ?? null);
                            break;
                          case "End":
                            event.preventDefault();
                            moveFocus(
                              visibleNodes[visibleNodes.length - 1]?.node.id ??
                                null
                            );
                            break;
                          case " ":
                          case "Enter":
                            event.preventDefault();
                            onSelect(node.collection, node.path || undefined);
                            break;
                        }
                      }}
                      ref={(element) => {
                        if (!element) {
                          nodeRefs.current.delete(node.id);
                          return;
                        }
                        nodeRefs.current.set(node.id, element);
                      }}
                      role="treeitem"
                      style={{ paddingLeft: `${node.depth * 0.9 + 0.5}rem` }}
                      tabIndex={
                        activeTabTargetMounted
                          ? node.id === activeTabTarget
                            ? 0
                            : -1
                          : localIndex === 0
                            ? 0
                            : -1
                      }
                      type="button"
                    >
                      {hasChildren ? (
                        isExpanded ? (
                          <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                        )
                      ) : (
                        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {node.name}
                      </span>
                      <span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {node.documentCount}
                      </span>
                    </button>
                    {node.kind === "collection" && (
                      <button
                        aria-label={
                          isFavorite
                            ? `Unpin ${node.collection}`
                            : `Pin ${node.collection}`
                        }
                        className="flex size-8 items-center justify-center rounded-md opacity-50 transition hover:bg-muted/50 hover:opacity-100"
                        onClick={() =>
                          onToggleFavoriteCollection(node.collection)
                        }
                        type="button"
                      >
                        <StarIcon
                          className={cn(
                            "size-3.5",
                            isFavorite && "fill-current text-secondary"
                          )}
                        />
                      </button>
                    )}
                  </div>
                </Fragment>
              );
            })}
            {bottomSpacerPx > 0 && (
              <div
                aria-hidden="true"
                style={{ height: `${bottomSpacerPx}px` }}
              />
            )}
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
