import { FolderIcon, FolderPlusIcon } from "lucide-react";

import type { SuggestedCollection } from "../../status-model";

import { Button } from "./ui/button";

interface CollectionsEmptyStateProps {
  suggestedCollections: SuggestedCollection[];
  onAddCollection: (path?: string) => void;
}

export function CollectionsEmptyState({
  suggestedCollections,
  onAddCollection,
}: CollectionsEmptyStateProps) {
  return (
    <div className="mx-auto max-w-3xl py-16 text-center">
      <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-muted">
        <FolderIcon className="size-8 text-muted-foreground" />
      </div>
      <h2 className="mb-2 font-semibold text-2xl">No folders connected yet</h2>
      <p className="mx-auto mb-8 max-w-xl text-muted-foreground">
        Add the notes, docs, or project folders you want GNO to watch. It will
        start indexing as soon as you connect one.
      </p>

      <div className="mb-8 flex flex-wrap justify-center gap-3">
        <Button onClick={() => onAddCollection()}>
          <FolderPlusIcon className="mr-2 size-4" />
          Add Folder
        </Button>
        {suggestedCollections.map((suggestion) => (
          <Button
            key={suggestion.path}
            onClick={() => onAddCollection(suggestion.path)}
            variant="outline"
          >
            {suggestion.label}
          </Button>
        ))}
      </div>

      {suggestedCollections.length > 0 && (
        <div className="grid gap-3 text-left md:grid-cols-2">
          {suggestedCollections.map((suggestion) => (
            <div
              className="rounded-xl border border-border/60 bg-background/70 p-4"
              key={`${suggestion.path}-detail`}
            >
              <div className="mb-1 font-medium">{suggestion.label}</div>
              <div className="font-mono text-muted-foreground text-xs">
                {suggestion.path}
              </div>
              <p className="mt-2 text-muted-foreground text-sm">
                {suggestion.reason}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
