---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-110-file-and-export-first-source-adapters.3 Implement safe EML and streaming MBOX adapters

## Description
Deliver implement safe eml and streaming mbox adapters as one implementation-sized increment.

**Size:** M
**Files:** `src/converters/adapters/email/adapter.ts`, `src/converters/adapters/email/mime.ts`, `test/converters/email.test.ts`, `test/fixtures/exports/mail`

### Approach
- Parse RFC 5322 header unfolding, Message-ID/In-Reply-To/References identity, MIME multipart nesting, transfer encodings, and sanitized text/HTML bodies.
- Use Message-ID as primary identity and canonical header/body hash plus occurrence disclosure when missing/duplicated; stream MBOX messages without loading the container.
- Inventory attachments with filename/type/size/hash under caps; reject dangerous schemes and never fetch or execute attachment content.

### Investigation targets
**Required** (read before coding):
- `src/converters/mime.ts`
- `src/converters/canonicalize.ts`
- `src/core/capture.ts`

**Optional** (reference as needed):
- `src/converters/native/plaintext.ts`
- `src/ingestion/frontmatter.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/ingestion/record-adapter.ts`

### Key context
- Review dependency health/licensing/lifecycle scripts before adding any MIME package; prefer existing Bun/native capabilities when adequate.

## Acceptance
- [ ] EML/MBOX fixtures preserve message/thread identity, participants, dates, sanitized body, and attachment inventory.
- [ ] Folded headers, nested MIME, base64/quoted-printable, encodings, duplicate/missing IDs, malformed messages, and large mailboxes are bounded and deterministic.
- [ ] No attachment URL/file executes, auto-fetches, or enters the index outside the declared safe body contract.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
