# T13.7: Quick capture command

**Migrated from:** gno-ub9.15
**Priority:** P2

## Description

Implement quick note capture command.

## File

src/capture.tsx

## Trigger Keywords

capture, new note, quick note

## Component

Form

## Backend

REST API (apiCreateDoc) - requires gno serve running

## Path Generation

`inbox/YYYYMMDD-HHmmss-<slug>.md`

- Timestamp: YYYYMMDD-HHmmss (NO COLONS - filesystem safe)
- Slug: lowercase, hyphens, no special chars

## Implementation

```typescript
import { Form, ActionPanel, Action, showToast, Toast, popToRoot } from '@raycast/api';
import { useState, useEffect } from 'react';
import { apiCreateDoc, apiCollections } from './lib/api';

function generatePath(title: string): string {
  const now = new Date();
  const ts = now.toISOString().slice(0,19).replace(/[-:T]/g, '').replace(/(.{8})/, '$1-');
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
  return `inbox/${ts}-${slug}.md`;
}

export default function CaptureCommand() {
  const [collections, setCollections] = useState<Collection[]>([]);

  useEffect(() => {
    apiCollections().then(setCollections).catch(() => {
      showToast({ style: Toast.Style.Failure, title: 'Start gno serve first' });
    });
  }, []);

  async function handleSubmit(values: { title: string; content: string; collection: string }) {
    const relPath = generatePath(values.title);
    const content = `# ${values.title}\n\n${values.content}`;

    try {
      await apiCreateDoc(values.collection, relPath, content);
      await showToast({ style: Toast.Style.Success, title: 'Note captured!' });
      await popToRoot();
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: 'Failed', message: String(e) });
    }
  }

  return (
    <Form actions={<ActionPanel><Action.SubmitForm title='Capture Note' onSubmit={handleSubmit} /></ActionPanel>}>
      <Form.TextField id='title' title='Title' placeholder='Note title...' />
      <Form.TextArea id='content' title='Content' placeholder='Write your note...' />
      <Form.Dropdown id='collection' title='Collection'>
        {collections.map(c => <Form.Dropdown.Item key={c.name} value={c.name} title={c.name} />)}
      </Form.Dropdown>
    </Form>
  );
}
```

## Error Handling

- API not running: Show toast with instructions
- CONFLICT (409): Job already running

## Checklist

- [ ] Form with title, content, collection
- [ ] Fetch collections on mount
- [ ] Generate filesystem-safe path
- [ ] Create document via API
- [ ] Success toast + popToRoot
- [ ] Error handling

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
