import type { CollectionRow, DocumentRow } from "../store/types";

export interface BrowseTreeNode {
  id: string;
  kind: "collection" | "folder";
  collection: string;
  path: string;
  name: string;
  depth: number;
  documentCount: number;
  directDocumentCount: number;
  children: BrowseTreeNode[];
}

type BrowseCollectionLike = Pick<CollectionRow, "name">;
type BrowseDocumentLike = Pick<
  DocumentRow,
  "collection" | "relPath" | "recordSourcePath" | "active"
>;
type BrowseFolderLike = {
  collection: string;
  path: string;
};

export function normalizeBrowsePath(path?: string | null): string {
  return (path ?? "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

export function createBrowseNodeId(collection: string, path = ""): string {
  const normalizedPath = normalizeBrowsePath(path);
  return normalizedPath
    ? `folder:${collection}:${normalizedPath}`
    : `collection:${collection}`;
}

function createNode(options: {
  kind: BrowseTreeNode["kind"];
  collection: string;
  path: string;
  name: string;
  depth: number;
}): BrowseTreeNode {
  return {
    id: createBrowseNodeId(options.collection, options.path),
    kind: options.kind,
    collection: options.collection,
    path: options.path,
    name: options.name,
    depth: options.depth,
    documentCount: 0,
    directDocumentCount: 0,
    children: [],
  };
}

function sortNodes(nodes: BrowseTreeNode[]): void {
  nodes.sort((a, b) => a.name.localeCompare(b.name));
  for (const node of nodes) {
    sortNodes(node.children);
  }
}

function ensureFolderNode(
  root: BrowseTreeNode,
  childrenByNode: Map<BrowseTreeNode, Map<string, BrowseTreeNode>>,
  collection: string,
  parts: readonly string[],
  incrementDocumentCount: boolean
): BrowseTreeNode {
  let current = root;
  let currentPath = "";

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    let childMap = childrenByNode.get(current);
    if (!childMap) {
      childMap = new Map<string, BrowseTreeNode>();
      childrenByNode.set(current, childMap);
    }
    let next = childMap.get(part);
    if (!next) {
      next = createNode({
        kind: "folder",
        collection,
        path: currentPath,
        name: part,
        depth: current.depth + 1,
      });
      childMap.set(part, next);
      current.children.push(next);
    }
    if (incrementDocumentCount) {
      next.documentCount += 1;
    }
    current = next;
  }

  return current;
}

export function buildBrowseTree(
  collections: BrowseCollectionLike[],
  documents: BrowseDocumentLike[],
  folders: BrowseFolderLike[] = []
): BrowseTreeNode[] {
  const roots = new Map<string, BrowseTreeNode>();
  const childrenByNode = new Map<BrowseTreeNode, Map<string, BrowseTreeNode>>();

  for (const collection of collections) {
    roots.set(
      collection.name,
      createNode({
        kind: "collection",
        collection: collection.name,
        path: "",
        name: collection.name,
        depth: 0,
      })
    );
  }

  for (const doc of documents) {
    if (!doc.active) {
      continue;
    }

    let root = roots.get(doc.collection);
    if (!root) {
      root = createNode({
        kind: "collection",
        collection: doc.collection,
        path: "",
        name: doc.collection,
        depth: 0,
      });
      roots.set(doc.collection, root);
    }

    root.documentCount += 1;

    const normalizedRelPath = normalizeBrowsePath(
      doc.recordSourcePath ?? doc.relPath
    );
    const parts = normalizedRelPath.split("/").filter(Boolean);
    const folderParts = parts.slice(0, -1);

    if (folderParts.length === 0) {
      root.directDocumentCount += 1;
      continue;
    }

    const leaf = ensureFolderNode(
      root,
      childrenByNode,
      doc.collection,
      folderParts,
      true
    );
    leaf.directDocumentCount += 1;
  }

  for (const folder of folders) {
    let root = roots.get(folder.collection);
    if (!root) {
      root = createNode({
        kind: "collection",
        collection: folder.collection,
        path: "",
        name: folder.collection,
        depth: 0,
      });
      roots.set(folder.collection, root);
    }
    const parts = normalizeBrowsePath(folder.path).split("/").filter(Boolean);
    if (parts.length > 0) {
      ensureFolderNode(root, childrenByNode, folder.collection, parts, false);
    }
  }

  const sortedRoots = [...roots.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const root of sortedRoots) {
    sortNodes(root.children);
  }
  return sortedRoots;
}

export function findBrowseNode(
  roots: BrowseTreeNode[],
  collection?: string | null,
  path?: string | null
): BrowseTreeNode | null {
  if (!collection) {
    return null;
  }

  const root = roots.find((node) => node.collection === collection);
  if (!root) {
    return null;
  }

  const normalizedPath = normalizeBrowsePath(path);
  if (!normalizedPath) {
    return root;
  }

  const parts = normalizedPath.split("/").filter(Boolean);
  let current = root;
  let currentPath = "";
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    const next = current.children.find(
      (child) => child.name === part || child.path === currentPath
    );
    if (!next) {
      return null;
    }
    current = next;
  }

  return current;
}

export function getBrowseAncestorIds(
  collection?: string | null,
  path?: string | null
): string[] {
  if (!collection) {
    return [];
  }

  const normalizedPath = normalizeBrowsePath(path);
  const ids = [createBrowseNodeId(collection)];
  if (!normalizedPath) {
    return ids;
  }

  const parts = normalizedPath.split("/").filter(Boolean);
  let currentPath = "";
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    ids.push(createBrowseNodeId(collection, currentPath));
  }
  return ids;
}

export function getImmediateChildFolders(
  roots: BrowseTreeNode[],
  collection?: string | null,
  path?: string | null
): BrowseTreeNode[] {
  const node = findBrowseNode(roots, collection, path);
  return node?.children ?? [];
}
