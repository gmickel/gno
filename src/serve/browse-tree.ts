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
  "collection" | "relPath" | "active"
>;

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

export function buildBrowseTree(
  collections: BrowseCollectionLike[],
  documents: BrowseDocumentLike[]
): BrowseTreeNode[] {
  const roots = new Map<string, BrowseTreeNode>();

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

    const normalizedRelPath = normalizeBrowsePath(doc.relPath);
    const parts = normalizedRelPath.split("/").filter(Boolean);
    const folderParts = parts.slice(0, -1);

    if (folderParts.length === 0) {
      root.directDocumentCount += 1;
      continue;
    }

    let current = root;
    let currentPath = "";
    for (const part of folderParts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let next = current.children.find((child) => child.path === currentPath);
      if (!next) {
        next = createNode({
          kind: "folder",
          collection: doc.collection,
          path: currentPath,
          name: part,
          depth: current.depth + 1,
        });
        current.children.push(next);
      }
      next.documentCount += 1;
      current = next;
    }

    current.directDocumentCount += 1;
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

  const queue = [...root.children];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) {
      continue;
    }
    if (node.path === normalizedPath) {
      return node;
    }
    queue.push(...node.children);
  }

  return null;
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
