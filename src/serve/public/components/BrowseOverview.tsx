import { ChevronRight, FolderOpen, StarIcon } from "lucide-react";

import type { BrowseTreeNode } from "../../browse-tree";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";

export function BrowseOverview({
  collections,
  favoriteCollections,
  onSelectCollection,
  onToggleFavoriteCollection,
}: {
  collections: BrowseTreeNode[];
  favoriteCollections: string[];
  onSelectCollection: (collection: string) => void;
  onToggleFavoriteCollection: (collection: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {collections.map((collection) => (
          <Card key={collection.id}>
            <CardContent className="space-y-4 py-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-lg">{collection.name}</h2>
                  <p className="text-muted-foreground text-sm">
                    {collection.documentCount} indexed docs
                  </p>
                </div>
                <Button
                  onClick={() =>
                    onToggleFavoriteCollection(collection.collection)
                  }
                  size="icon-sm"
                  variant="ghost"
                >
                  <StarIcon
                    className={`size-4 ${
                      favoriteCollections.includes(collection.collection)
                        ? "fill-current text-secondary"
                        : "text-muted-foreground"
                    }`}
                  />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">
                  {collection.children.length} folders
                </Badge>
                <Badge variant="outline">
                  {collection.directDocumentCount} root docs
                </Badge>
              </div>
              <Button
                className="w-full justify-between"
                onClick={() => onSelectCollection(collection.collection)}
                variant="outline"
              >
                Open collection
                <ChevronRight className="size-4" />
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {collections.length === 0 && (
        <div className="py-20 text-center">
          <FolderOpen className="mx-auto mb-4 size-12 text-muted-foreground" />
          <h3 className="mb-2 font-medium text-lg">No collections yet</h3>
          <p className="text-muted-foreground">
            Add a collection to populate the workspace tree.
          </p>
        </div>
      )}
    </div>
  );
}
