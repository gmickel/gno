# T13.1: Extension scaffold

**Migrated from:** gno-ub9.9
**Priority:** P1

## Description

Create Raycast extension scaffold with package.json and assets.

## Structure

```
gno-raycast/
├── package.json
├── tsconfig.json
├── src/
│   └── lib/
│       └── types.ts        # Shared types
└── assets/
    └── icon.png            # Extension icon
```

## package.json

- name: gno
- title: GNO - Local Knowledge Search
- description: Search your local documents with AI
- commands: (add as implemented)
- dependencies: @raycast/api

## Checklist

- [ ] npx create-raycast-extension
- [ ] Configure package.json metadata
- [ ] Add icon (512x512)
- [ ] Create types.ts with SearchResult, AskResponse, etc.
- [ ] Verify extension loads in Raycast

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
