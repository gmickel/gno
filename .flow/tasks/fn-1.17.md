# T13.10: Browse collections command

**Migrated from:** gno-ub9.18
**Priority:** P2

## Description

Implement collection browser command.

## File

src/browse.tsx

## Trigger Keywords

collections, browse, browse gno

## Component

List → List → Detail chain

## Backend

REST API (apiCollections, apiDocs, apiDoc)

## Flow

1. List collections (name, doc count, path)
2. Select collection → List documents
3. Select document → Detail view

## Implementation

```typescript
import { List, ActionPanel, Action, Icon } from '@raycast/api';
import { useState, useEffect } from 'react';
import { apiCollections } from './lib/api';

export default function BrowseCommand() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    apiCollections()
      .then(setCollections)
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <List isLoading={isLoading}>
      {collections.map(c => (
        <List.Item
          key={c.name}
          title={c.name}
          subtitle={c.path}
          accessories={[{ text: `${c.docCount} docs` }]}
          icon={Icon.Folder}
          actions={
            <ActionPanel>
              <Action.Push title='Browse Documents' target={<CollectionDocs collection={c.name} />} />
              <Action.ShowInFinder path={c.path} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

function CollectionDocs({ collection }: { collection: string }) {
  // Similar List for documents in collection
  // Action.Push to DocumentDetail for each doc
}

function DocumentDetail({ docid }: { docid: string }) {
  // Detail view with document content
  // Actions: Open, ShowInFinder, CopyPath
}
```

## Checklist

- [ ] Collections list with stats
- [ ] Documents list per collection
- [ ] Document detail view
- [ ] Actions at each level
- [ ] Loading states
- [ ] Error handling

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
