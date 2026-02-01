# T13.9: Update index command

**Migrated from:** gno-ub9.17
**Priority:** P2

## Description

Implement reindex/sync command.

## File

src/update.tsx

## Trigger Keywords

update gno, reindex, sync gno

## Component

No-view command with progress toast

## Backend

REST API (apiSync)

## Implementation

```typescript
import { showToast, Toast, showHUD } from "@raycast/api";
import { apiSync, apiGetJob } from "./lib/api";

export default async function Command() {
  try {
    await showToast({
      style: Toast.Style.Animated,
      title: "Updating index...",
    });

    const { jobId } = await apiSync();

    // Poll for completion
    let status = await apiGetJob(jobId);
    while (status.status === "running") {
      await new Promise((r) => setTimeout(r, 1000));
      status = await apiGetJob(jobId);
    }

    if (status.status === "complete") {
      await showHUD("Index updated");
    } else {
      await showToast({
        style: Toast.Style.Failure,
        title: "Update failed",
        message: status.error,
      });
    }
  } catch (error) {
    if (String(error).includes("ECONNREFUSED")) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Start gno serve first",
      });
    } else {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed",
        message: String(error),
      });
    }
  }
}
```

## Error Handling

- API not running: Toast 'Start gno serve first'
- CONFLICT (409): Already indexing - show toast

## Checklist

- [ ] Trigger sync via API
- [ ] Poll job status
- [ ] Progress toast
- [ ] Success HUD
- [ ] Error handling

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
