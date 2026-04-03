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

function flattenVisibleNodes(
  nodes: BrowseTreeNode[],
  expandedNodeIds: Set<string>,
  parentId: string | null = null
): VisibleBrowseNode[] {
  const flat: VisibleBrowseNode[] = [];

  for (const node of nodes) {
    flat.push({ node, parentId });
    if (node.children.length > 0 && expandedNodeIds.has(node.id)) {
      flat.push(
        ...flattenVisibleNodes(node.children, expandedNodeIds, node.id)
      );
    }
  }

  return flat;
}

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
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(
    selectedNodeId
  );
  const expandedNodeSet = useMemo(
    () => new Set(expandedNodeIds),
    [expandedNodeIds]
  );
  const visibleNodes = useMemo(
    () => flattenVisibleNodes(collections, expandedNodeSet),
    [collections, expandedNodeSet]
  );

  useEffect(() => {
    setFocusedNodeId(selectedNodeId);
  }, [selectedNodeId]);

  const favoriteRoots = collections.filter((node) =>
    favoriteCollections.includes(node.collection)
  );

  const moveFocus = (nodeId: string | null) => {
    if (!nodeId) {
      return;
    }
    setFocusedNodeId(nodeId);
    nodeRefs.current.get(nodeId)?.focus();
  };

  const getVisibleIndex = (nodeId: string | null) =>
    visibleNodes.findIndex((entry) => entry.node.id === nodeId);

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
          <div aria-label="Browse tree" role="tree">
            {visibleNodes.map(({ node, parentId }, index) => {
              const isExpanded = expandedNodeSet.has(node.id);
              const isSelected = node.id === selectedNodeId;
              const isFocused = node.id === focusedNodeId;
              const hasChildren = node.children.length > 0;

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
                        isFocused ||
                        (!focusedNodeId && index === 0) ||
                        (selectedNodeId === null && index === 0)
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
                          favoriteCollections.includes(node.collection)
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
                            favoriteCollections.includes(node.collection) &&
                              "fill-current text-secondary"
                          )}
                        />
                      </button>
                    )}
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
