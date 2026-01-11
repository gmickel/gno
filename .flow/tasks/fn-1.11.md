# T13.4: Search command (BM25)

**Migrated from:** gno-ub9.12
**Priority:** P2

## Description

Implement BM25 keyword search command.

## File

src/search.tsx

## Trigger Keywords

gno, search notes, find notes

## Component

List with instant search

## Backend

CLI (gnoSearch) - fast, no model loading

## Implementation

```typescript
import { List, ActionPanel, Action } from '@raycast/api';
import { useState, useEffect } from 'react';
import { gnoSearch } from './lib/cli';

export default function SearchCommand() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    setIsLoading(true);
    gnoSearch(query).then(r => {
      setResults(r);
      setIsLoading(false);
    }).catch(handleError);
  }, [query]);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder='Search your notes...'
      onSearchTextChange={setQuery}
      throttle
    >
      {results.map(result => (
        <List.Item
          key={result.docid}
          title={result.title || result.uri.split('/').pop() || ''}
          subtitle={result.snippet.slice(0, 100)}
          accessories={[{ text: `${(result.score * 100).toFixed(0)}%` }]}
          actions={
            <ActionPanel>
              <Action.Open title='Open in Editor' target={result.uri} />
              <Action.ShowInFinder path={result.uri} />
              <Action.CopyToClipboard content={result.uri} title='Copy Path' />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
```

## Checklist

- [ ] List component with search
- [ ] Debounced/throttled search
- [ ] Result items with title, snippet, score
- [ ] Actions: Open, ShowInFinder, CopyPath
- [ ] Loading state
- [ ] Empty state
- [ ] Error handling (gno not installed)

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
