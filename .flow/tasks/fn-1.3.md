# T13.14: Unit tests for CLI wrapper

**Migrated from:** gno-ub9.4
**Priority:** P2

## Description

Test the CLI wrapper module (src/lib/cli.ts).

## Test Cases

- Parse valid JSON output from gno search
- Parse valid JSON output from gno query
- Handle gno not installed (command not found)
- Handle gno command error (non-zero exit)
- Handle malformed JSON output
- Handle timeout
- Escape shell arguments properly

## Test File

gno-raycast/src/lib/cli.test.ts

## Patterns

Use Bun test (bun:test) to match GNO codebase style

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
