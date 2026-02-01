# T13.21: AI model preset selector

**Migrated from:** gno-ub9.21
**Priority:** P3

## Description

## Summary

Add AI model preset control matching web UI's AIModelSelector.

## API Endpoints

- `GET /api/presets` - List presets + active + capabilities
- `POST /api/presets` - Switch preset: `{ presetId }`
- `GET /api/models/status` - Download progress
- `POST /api/models/pull` - Start model download

## Implementation

### Raycast Preference (Simple)

```json
{
  "name": "aiPreset",
  "title": "AI Model",
  "description": "Model quality preset",
  "type": "dropdown",
  "default": "default"
}
```

Populate dynamically on first run from `/api/presets`.

### Or: Dedicated Command

"Manage AI Models" command that:

1. Lists available presets
2. Shows active preset with checkmark
3. Allows switching (Action: Set as Active)
4. Shows download progress if models missing
5. Action: Download Models

## Capabilities Check

Before Ask command, check capabilities:

```typescript
const { data } = await apiRequest<PresetsResponse>("/api/presets");
if (!data.capabilities.answer) {
  // Show toast: "AI model not loaded. Download models first."
  // Offer action to open Manage AI Models command
}
```

## Notes

- Model switching can take a few seconds (unload/load)
- Download can take minutes (show progress toast)

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
