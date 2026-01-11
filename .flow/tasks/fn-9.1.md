# Fix bun test failures in cli search/tag/global options

## Description

bun test failed in full suite:\n- test/cli/search-fixtures.test.ts (bcrypt, multi-stage, --full, --line-numbers) timeouts/empty stdout\n- test/cli/tags.test.ts (tag filters) timeouts/empty stdout\n- test/cli/global-options.test.ts defaults expect color=true but got false\nSee run from 2026-01-05; failures show empty stdout and 5s timeouts. Might be pager/env or CLI output changes.

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
- [ ] Documentation updated
