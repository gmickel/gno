---
title: "Request recovery must revalidate dependent state, not just its own file"
date: "2026-09-24"
track: bug
category: data
module: src/core/request-receipts.ts
tags: [fn-170, request-receipts, recovery, idempotency]
problem_type: data
symptoms: "Retry after interrupted write re-applied stale tags, double-superseded, or recreated a deleted note"
root_cause: Recovery checked only the request's own file hash and used an index-local row ID
resolution_type: fix
---

## Problem
Durable request receipts recover an interrupted write by checking only whether this request's own file landed ("published"), then finishing it. Review found three recovery paths that were safe on disk but not semantically: a supersede whose successor sat unprojected could be finished after another request superseded the same predecessor (two successors); a tag-only document update (no file change) resumed unconditionally and re-applied stale tags over a newer save, using an index-local row ID that does not survive rebuilds; and a write whose file was later deleted or reverted by the user looked "absent" and would be re-executed.

## What Didn't Work
Treating "our file is present with the expected hash" as the whole recovery condition, and keying non-file side effects (store tags) by the SQLite row ID captured at admission.

## Solution
- Record a `published` flag in the ledger right after publication; on recovery `absent` + published becomes `unexpected` (REQUEST_RECOVERY_CONFLICT), so deleted/reverted targets are never recreated (`src/core/request-receipts.ts`).
- Supersede recovery re-checks the predecessor's supersedes backlinks and refuses if any successor other than its own exists (`src/core/memory-remember.ts` inspect).
- Tag-only recovery records base/result tag-state fingerprints plus the base file hash, resolves the document by its gno:// URI, and resumes only from exactly those states (`src/serve/routes/api.ts` handleUpdateDoc).

## Prevention
For every recoverable operation, ask what *other* state the side effect depends on besides the file it writes (graph edges, store rows, tags) and fingerprint that state at admission. Store stable identities (URIs), never row IDs, in any ledger that outlives the index. Pin each recovery guard with an interrupted-A / competing-B / retry-A regression and a mutation check.
