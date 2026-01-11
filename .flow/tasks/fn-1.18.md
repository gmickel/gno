# T13.11: Raycast Store submission

**Migrated from:** gno-ub9.19
**Priority:** P2

## Description

Submit extension to Raycast Store.

## Prerequisites

- All commands working (T13.4-T13.10)
- Store assets ready (T13.17)
- Documentation complete (T13.12)
- Tests passing (T13.14, T13.15)

## Submission Process

1. Fork raycast/extensions repo
2. Add gno-raycast to extensions/
3. Run npm run lint
4. Run npm run build
5. Create PR with:
   - Title: 'Add GNO extension'
   - Description from T13.17
   - Screenshots attached

## PR Checklist (from Raycast docs)

- [ ] Extension builds without errors
- [ ] All commands have icons
- [ ] package.json metadata complete
- [ ] README.md in extension folder
- [ ] Screenshots (1280x800 or 2560x1600)
- [ ] No console.log statements
- [ ] Follows Raycast design guidelines

## Review Process

- Raycast team reviews within ~1 week
- May request changes
- Once approved, merged to main
- Appears in Store within 24h

## Reference

https://developers.raycast.com/basics/publish-an-extension

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
