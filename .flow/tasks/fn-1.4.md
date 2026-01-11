# T13.15: Unit tests for API client

**Migrated from:** gno-ub9.5
**Priority:** P2

## Description

Test the REST API client module (src/lib/api.ts).

## Test Cases

- Successful responses (200, 201)
- Error responses (400, 403, 404, 409, 413, 422, 500)
- Parse error envelope: { error: { code, message } }
- Handle network errors (fetch throws)
- Handle server not running (ECONNREFUSED)
- X-GNO-Token header when configured

## Error Codes to Test

- NOT_FOUND (404)
- FILE_NOT_FOUND (404)
- NOT_EDITABLE (403)
- CONFLICT (409)
- FILE_TOO_LARGE (413)
- ENCODING_ERROR (422)
- CSRF_VIOLATION (403)

## Test File

gno-raycast/src/lib/api.test.ts

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
