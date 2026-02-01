# T13.8: Add folder command (Finder integration)

**Migrated from:** gno-ub9.16
**Priority:** P2

## Description

Implement Finder integration to add selected folders to GNO.

## File

src/add-folder.tsx

## Trigger Keywords

index folder, add to gno, gno add

## Component

No-view command (uses getSelectedFinderItems)

## Backend

REST API (apiAddCollection)

## Implementation

```typescript
import {
  getSelectedFinderItems,
  showToast,
  Toast,
  showHUD,
} from "@raycast/api";
import { apiAddCollection, apiGetJob } from "./lib/api";

export default async function Command() {
  try {
    const selectedItems = await getSelectedFinderItems();

    if (selectedItems.length === 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: "No folder selected",
        message: "Select a folder in Finder first",
      });
      return;
    }

    // Filter to directories only
    const folders = selectedItems.filter((item) => !item.path.includes("."));

    if (folders.length === 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: "No folders selected",
        message: "Select folders, not files",
      });
      return;
    }

    await showToast({ style: Toast.Style.Animated, title: "Adding to GNO..." });

    for (const folder of folders) {
      const { jobId } = await apiAddCollection(folder.path);
      // Optionally poll job status
    }

    await showHUD(`Added ${folders.length} folder(s) to GNO`);
  } catch (error) {
    if (String(error).includes("ECONNREFUSED")) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Start gno serve first",
      });
    } else {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to add folder",
        message: String(error),
      });
    }
  }
}
```

## Error Handling

- No Finder selection: Toast with instructions
- Files selected (not folders): Toast with instructions
- API not running: Toast 'Start gno serve first'
- CONFLICT (409): Already indexing

## Checklist

- [ ] getSelectedFinderItems() integration
- [ ] Filter to directories
- [ ] Call apiAddCollection for each
- [ ] Progress toast
- [ ] Success HUD
- [ ] Error handling for all cases

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
