# T13.16: Error handling + graceful degradation

**Migrated from:** gno-ub9.6
**Priority:** P1

## Description

Implement robust error handling across all commands.

## Scenarios

### gno CLI not installed

- Detect: execAsync throws ENOENT
- UX: Show toast with install instructions
- Link: https://gno.sh/docs/quickstart/

### gno serve not running

- Detect: fetch throws ECONNREFUSED
- UX: Show toast 'Start gno serve first' OR fallback to CLI
- Fallback matrix:
  - Search → CLI (works)
  - Semantic → CLI (works)
  - Ask → CLI (slow but works)
  - Capture → FAIL (needs API)
  - Add folder → FAIL (needs API)

### Cold start delay

- First AI query loads models (~10-30s)
- UX: Show 'Loading models...' with progress
- Consider: Ping /api/capabilities first

### API errors

- Parse { error: { code, message } } envelope
- Map codes to user-friendly messages
- Show appropriate Toast.Style (Failure vs Warning)

## Implementation

- Create src/lib/errors.ts with error types
- Create src/lib/fallback.ts for CLI fallback logic
- Update each command to use error handling

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
