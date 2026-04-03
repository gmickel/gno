import type { BrowseTreeNode } from "../../browse-tree";

export interface BrowseDocument {
  docid: string;
  uri: string;
  title: string | null;
  collection: string;
  relPath: string;
  sourceExt: string;
}

export interface DocsResponse {
  documents: BrowseDocument[];
  total: number;
  limit: number;
  offset: number;
  pathPrefix?: string;
  directChildrenOnly?: boolean;
  availableDateFields: string[];
  sortField: string;
  sortOrder: "asc" | "desc";
}

export interface BrowseTreeResponse {
  collections: BrowseTreeNode[];
  totalCollections: number;
  totalDocuments: number;
}

export function parseBrowseLocation(search: string): {
  collection: string;
  path: string;
} {
  const params = new URLSearchParams(search);
  return {
    collection: params.get("collection") ?? "",
    path: (params.get("path") ?? "")
      .replaceAll("\\", "/")
      .replace(/^\/+|\/+$/g, ""),
  };
}

export function buildBrowseLocation(
  collection?: string,
  path?: string
): string {
  const normalizedCollection = collection?.trim() ?? "";
  const normalizedPath = (path ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");

  if (!normalizedCollection) {
    return "/browse";
  }

  const params = new URLSearchParams({
    collection: normalizedCollection,
  });
  if (normalizedPath) {
    params.set("path", normalizedPath);
  }
  return `/browse?${params.toString()}`;
}

export function buildBrowseCrumbs(collection: string, path: string) {
  const crumbs = [
    {
      label: collection,
      location: buildBrowseLocation(collection),
    },
  ];

  if (!path) {
    return crumbs;
  }

  const parts = path.split("/").filter(Boolean);
  let currentPath = "";
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    crumbs.push({
      label: part,
      location: buildBrowseLocation(collection, currentPath),
    });
  }
  return crumbs;
}

export function formatDateFieldLabel(field: string) {
  return field
    .split("_")
    .filter((token) => token.length > 0)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

export function getExtBadgeVariant(ext: string) {
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
}
