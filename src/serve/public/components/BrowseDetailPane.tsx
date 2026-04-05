import { ChevronRight, FileText, FolderOpen, StarIcon } from "lucide-react";

import type { BrowseTreeNode } from "../../browse-tree";
import type { BrowseDocument } from "../lib/browse";

import { getExtBadgeVariant } from "../lib/browse";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";

export function BrowseDetailPane({
  childFolders,
  docs,
  docsLoading,
  favoriteDocHrefs,
  onLoadMore,
  onOpenDoc,
  onSelectCollection,
  onSelectFolder,
  onToggleFavoriteDocument,
  selectedNode,
  selectedPath,
  total,
}: {
  childFolders: BrowseTreeNode[];
  docs: BrowseDocument[];
  docsLoading: boolean;
  favoriteDocHrefs: string[];
  onLoadMore: () => void;
  onOpenDoc: (uri: string) => void;
  onSelectCollection: (collection: string) => void;
  onSelectFolder: (collection: string, path?: string) => void;
  onToggleFavoriteDocument: (doc: BrowseDocument) => void;
  selectedNode: BrowseTreeNode | null;
  selectedPath: string;
  total: number;
}) {
  const formatModified = (value?: string) => {
    if (!value) return "—";
    try {
      return new Date(value).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return value;
    }
  };

  if (docsLoading && docs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <div className="text-muted-foreground">Loading folder contents...</div>
      </div>
    );
  }

  if (docs.length === 0 && childFolders.length === 0) {
    return (
      <div className="py-20 text-center">
        <FileText className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h3 className="mb-2 font-medium text-lg">No documents found</h3>
        <p className="text-muted-foreground">
          {selectedPath
            ? "This folder is empty"
            : "This collection root has no documents yet"}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {childFolders.map((folder) => (
          <Card key={folder.id}>
            <CardContent className="space-y-3 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{folder.name}</div>
                  <div className="text-muted-foreground text-sm">
                    {folder.documentCount} docs
                  </div>
                </div>
                <FolderOpen className="size-4 text-muted-foreground" />
              </div>
              <Button
                className="w-full justify-between"
                onClick={() => onSelectFolder(folder.collection, folder.path)}
                variant="outline"
              >
                Open folder
                <ChevronRight className="size-4" />
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-sm">
            {selectedNode?.directDocumentCount ?? docs.length} direct docs
          </div>
          <div className="text-muted-foreground text-sm">
            {selectedNode?.documentCount ?? total} total docs in scope
          </div>
        </div>

        {docs.length > 0 && (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[56%]">Document</TableHead>
                <TableHead className="w-[130px]">Modified</TableHead>
                <TableHead className="w-[220px]">Collection</TableHead>
                <TableHead className="w-[72px] text-right">Type</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.map((doc) => (
                <TableRow
                  className="group cursor-pointer"
                  key={doc.docid}
                  onClick={() => onOpenDoc(doc.uri)}
                >
                  <TableCell className="align-top whitespace-normal">
                    <div className="flex items-center gap-2">
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="break-words font-medium leading-tight transition-colors group-hover:text-primary">
                          {doc.title || doc.relPath}
                        </div>
                        <div className="break-all font-mono text-muted-foreground text-xs leading-relaxed">
                          {doc.relPath}
                        </div>
                      </div>
                      <Button
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleFavoriteDocument(doc);
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
                  <TableCell className="align-top whitespace-normal text-muted-foreground text-xs">
                    {formatModified(doc.updatedAt)}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <Badge
                      className="inline-flex min-h-[2.5rem] max-w-[180px] cursor-pointer items-center px-3 py-1 text-center whitespace-normal break-words font-mono text-xs leading-tight transition-colors hover:border-primary hover:text-primary"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectCollection(doc.collection);
                      }}
                      variant="outline"
                    >
                      {doc.collection}
                    </Badge>
                  </TableCell>
                  <TableCell className="align-top text-right">
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
        )}

        {docs.length < total && (
          <div className="flex justify-center pt-4">
            <Button
              disabled={docsLoading}
              onClick={onLoadMore}
              variant="outline"
            >
              {docsLoading ? "Loading..." : "Load More"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
