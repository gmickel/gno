# T13.6: Ask command (AI answers)

**Migrated from:** gno-ub9.14
**Priority:** P2

## Description

Implement AI-powered Q&A command.

## File

src/ask.tsx

## Trigger Keywords

ask gno, question, ask notes

## Component

Form → Detail flow

## Backend

REST API (apiAsk) - models stay loaded = 10x faster
Fallback: CLI (gnoAsk) if API not running

## Flow

1. Form: Question input
2. Submit: Call apiAsk (or gnoAsk fallback)
3. Detail: Show answer with citations

## Implementation

```typescript
import { Form, Detail, ActionPanel, Action, showToast, Toast } from '@raycast/api';
import { useState } from 'react';
import { apiAsk, isApiRunning } from './lib/api';
import { gnoAsk } from './lib/cli';

export default function AskCommand() {
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(values: { question: string }) {
    setIsLoading(true);
    try {
      // Prefer API (faster), fallback to CLI
      const response = await isApiRunning()
        ? apiAsk(values.question)
        : gnoAsk(values.question);
      setAnswer(response);
    } catch (e) {
      await showToast({ style: Toast.Style.Failure, title: 'Failed', message: String(e) });
    }
    setIsLoading(false);
  }

  if (!answer) {
    return (
      <Form onSubmit={handleSubmit} isLoading={isLoading}>
        <Form.TextField id='question' title='Question' placeholder='Ask about your notes...' />
      </Form>
    );
  }

  const markdown = `# Answer\n\n${answer.answer}\n\n## Sources\n\n${answer.citations?.map((c, i) => `${i + 1}. ${c.uri}`).join('\n')}`;

  return (
    <Detail
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard content={answer.answer || ''} title='Copy Answer' />
          <Action title='Ask Another' onAction={() => setAnswer(null)} />
        </ActionPanel>
      }
    />
  );
}
```

## Cold Start UX

- First query loads models (~10-30s)
- Show 'Loading models...' toast
- Consider checking /api/capabilities first

## Checklist

- [ ] Form for question input
- [ ] API call with fallback to CLI
- [ ] Detail view for answer
- [ ] Citations list with links
- [ ] Copy answer action
- [ ] Ask another action
- [ ] Cold start loading indicator
- [ ] Error handling

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
