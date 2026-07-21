---
satisfies: [R1, R2, R3, R4, R5, R6, R7, R8]
---
# fn-111-collection-egress-policies.6 Prove migration adversarial enforcement and public security docs

## Description
Deliver prove migration adversarial enforcement and public security docs as one implementation-sized increment.

**Size:** M
**Files:** `test/egress`, `test/mcp/http-security.test.ts`, `test/publish`, `docs/CONFIGURATION.md`, `docs/MCP.md`, `docs/PUBLISHING.md`, `assets/skill/SKILL.md`, `/Users/gordon/work/gno.sh/src/routes/privacy.tsx`

### Approach
- Test legacy collections, existing public artifacts, queued jobs, sessions, one-shot local/remote confirmations, mixed sources, DNS/redirect/proxy/VPN/rebinding, audit purge, and rollback across package/platform fixtures.
- Document migration friction and irreversibility: old public content may require remote takedown; future publish/remote inference is denied until explicit policy.
- Update DB/spec/schemas/repo/skill/gno.sh privacy/publish/acceptable-use/pricing surfaces and run prerelease/package/security/deploy verification.

### Investigation targets
**Required** (read before coding):
- `spec/db/schema.sql`
- `docs/CONFIGURATION.md`
- `docs/MCP.md`
- `assets/skill/SKILL.md`
- `/Users/gordon/work/gno.sh/src/routes/privacy.tsx`

**Optional** (reference as needed):
- `docs/DAEMON.md`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `test/egress`

## Acceptance
- [ ] All adversarial destination/auth/mixed/derived/migration/session/job/audit cases fail closed or disclose explicit partial behavior.
- [ ] Existing local retrieval/indexing survives migration; blocked network actions explain exact safe remediation.
- [ ] Specs/schemas/docs/skill/gno.sh retain deferred-private and never-server-decrypt boundaries, and full verification/deploy gates pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
