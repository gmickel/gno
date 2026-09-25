---
title: Retries and Request IDs
description: Retry a GNO capture, remember, or document save after a lost response without writing twice.
keywords: gno request id, retry safe writes, idempotent capture, gno request-status, lost response
---

# Retries and Request IDs

A write can succeed while its response is lost: a timeout, a dropped
connection, a killed process, a server restart. Resending the same call blindly
can then capture a note twice, supersede a fact twice, or overwrite a newer
edit. A **request ID** lets you retry safely: GNO records the write under the
ID and a retry with the same ID returns the recorded outcome instead of running
again.

Request IDs are opt-in. Calls without one keep their response shapes; see
[Writes without a request ID](#writes-without-a-request-id) for what changed
for them.

This guide is the reference for request-ID semantics, the error codes,
namespaces, and the ledger's storage and retention. The CLI, REST, MCP, and SDK
references document only their own flag, field, or call and link here.

## Where request IDs are accepted

| Operation                    | CLI                                                     | MCP                        | REST                                    | SDK                                   |
| :--------------------------- | :------------------------------------------------------ | :------------------------- | :-------------------------------------- | :------------------------------------ |
| Capture a note               | `gno capture ... --request-id <id>`                     | `gno_capture` `requestId`  | `POST /api/capture` `requestId`         | `client.capture({ ..., requestId })`  |
| Remember (add or supersede)  | `gno remember ... --add\|--supersede --request-id <id>` | `gno_remember` `requestId` | `POST /api/memory/remember` `requestId` | `client.remember({ ..., requestId })` |
| Save a document (edit, tags) | not available                                           | not available              | `PUT /api/docs/:id` `requestId`         | not available                         |
| Look up a request ID         | `gno request-status <id> [--json]`                      | `gno_request_status`       | `GET /api/requests/:requestId`          | `client.requestStatus(id)`            |

- **Format**: 1-128 characters of letters, digits, `.`, `_`, `:` and `-`,
  starting with a letter or digit. A UUID works. A malformed ID is rejected
  with `REQUEST_ID_INVALID` before anything is written.
- **Remember** accepts a request ID only together with a decision (`add` or
  `supersede`). A candidates-only call with a request ID is rejected
  `REQUEST_ID_INVALID`.
- **Browser clipper**: `POST /api/capture/clip` does not accept `requestId`
  (a body containing it returns `400 CLIPPER_INVALID_REQUEST`). It keeps its
  own `Idempotency-Key` header contract.
- **MCP**: `gno_request_status` is read-only but registered only with
  `--enable-write`, on the `full` tool profile. The `core` profile does not
  include it.

## The retry loop

1. Generate a fresh ID for each write intent and keep it before you send.
2. If the response is lost, look the ID up before retrying.
3. Act on the status:

| Status      | Meaning                                                                                           | What to do                                                                                                                    |
| :---------- | :------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------- |
| `committed` | The write finished. `result` points at what it produced.                                          | Do not resend. Resending the same call only replays the recorded outcome.                                                     |
| `pending`   | The write was accepted but has not finished: still running, or interrupted (crash, sync failure). | Resend the exact same call with the same ID. GNO finishes it (or answers `REQUEST_PENDING` while another attempt still runs). |
| `not_found` | Nothing was accepted under this ID (or it was rejected before any write).                         | Resend the same call with the same ID.                                                                                        |
| `expired`   | The ID was committed more than 30 days ago and its outcome was compacted.                         | It will not run again. Check the current state before using a new ID.                                                         |

```bash
id=$(uuidgen)
gno capture "Release moves to Friday" --collection notes --request-id "$id" --json
# ...response lost? Check first:
gno request-status "$id"
# Pending or not found: run the exact same capture command again with the same --request-id.
```

A lookup result is a content-free pointer; it never contains note or fact
text:

```json
{
  "requestId": "0f8e5c1a-3c1e-4d0b-9a57-2f4f3b8f2c11",
  "status": "committed",
  "operation": "capture",
  "createdAt": "2026-09-24T08:00:00.000Z",
  "updatedAt": "2026-09-24T08:00:00.120Z",
  "result": {
    "uri": "gno://notes/inbox/2026-09-24/capture-3f9c.md",
    "docid": "#a1b2c3",
    "contentHash": "3f9c..."
  }
}
```

`operation` is `capture`, `remember`, or `document.update`. `result` appears
only for `committed` and carries `uri`, `docid`, and `contentHash` (capture,
remember) or `sourceHash` (document save). A `not_found` result carries only
`requestId` and `status`. Schema:
`spec/output-schemas/request-status.schema.json`.

## What a write returns

When a request ID was sent, a successful result gains one field:

```json
"request": {
  "requestId": "0f8e5c1a-3c1e-4d0b-9a57-2f4f3b8f2c11",
  "status": "committed",
  "replayed": false,
  "committedAt": "2026-09-24T08:00:00.120Z"
}
```

- First execution: `replayed: false`.
- Identical retry: the recorded outcome is returned unchanged with
  `replayed: true`. Nothing is executed again. REST replays keep the original
  HTTP status (`201` for a created capture or written fact).
- A replayed document save returns `jobId: null`; the original save already
  started the background sync.
- CLI text output adds `Request: <id> committed`, plus
  `(replayed, nothing written again)` on a replay.

Every write result references one shared definition of this object:
`$defs/requestReceipt` in `spec/output-schemas/request-status.schema.json`.

## What counts as the same request

The same ID with the same payload, destination, and expected revision (or
predecessor) is the same intent, and a retry replays or finishes it. Transport
details are not part of the intent: `caller` and `session` on remember, MCP
session IDs, and server instance IDs are ignored, so a retry after a reconnect
or a server restart still matches.

The same ID with a different payload, destination, revision, predecessor, or
operation is rejected `REQUEST_ID_CONFLICT`. Use a new ID for a new intent;
never reuse an ID for changed content.

Concurrent identical requests converge on one outcome: one runs, the others
replay it. If the running writer holds the write lease past the wait window,
the others get `REQUEST_PENDING`; retry later with the same ID.

## Committed, pending, and recovery

A request is **committed** only when the write is complete:

| Operation          | Committed when                                                                 |
| :----------------- | :----------------------------------------------------------------------------- |
| Capture            | The note file is written and lexically synced (searchable).                    |
| Remember add       | The fact file is written and lexically synced (recallable).                    |
| Remember supersede | The successor is written and synced, and its `supersedes` edge is projected.   |
| Document save      | The source file is written and its new source hash recorded (tags stored too). |

An exact-duplicate remember `add` sent with a request ID is recorded as its
`existing` outcome and replays as such.

A document save's lexical sync runs as a background job and its embedding
through the scheduler. Their failure never undoes a committed save; recover
with `gno update` and `gno embed`.

A request that was **rejected before any write** (validation error, stale
predecessor hash, supersede conflict, document revision `CONFLICT`, missing
document, busy lease) records nothing. `request-status` shows `not_found`, and
retrying the same ID evaluates the request again against the current state.

A request that was **accepted and written but interrupted** (crash, killed
process, or a sync failure such as `CAPTURE_SYNC_FAILED`,
`MEMORY_SYNC_FAILED`, or `MEMORY_SUPERSEDE_PROJECTION_FAILED`) stays
`pending`. With a request ID, a sync failure is returned as an error on every
surface, including CLI and SDK capture. Retrying with the same ID finishes the recorded write (sync,
projection) instead of writing it again. Retrying with a new ID would be a
second write.

If the recorded target changed after GNO wrote it (the file was deleted,
edited, reverted, or deleted and recreated), the retry fails with
`REQUEST_RECOVERY_CONFLICT` and leaves the file as it is. GNO never recreates
a note you deleted and never overwrites a change made after its write. Inspect
the target and decide; if the write is still wanted, send it with a new ID.

The guarantee covers one durable local write per admitted request. It makes no
claim about external systems, and deferred work (a document save's background
sync, embeddings) is separate.

## Errors

| Code                         | Meaning                                                    | HTTP | CLI exit | SDK `code` |
| :--------------------------- | :--------------------------------------------------------- | :--- | :------- | :--------- |
| `REQUEST_ID_INVALID`         | Malformed ID, or an ID on a call that does not write       | 400  | 1        | VALIDATION |
| `REQUEST_ID_CONFLICT`        | ID already used for a different intent                     | 409  | 1        | VALIDATION |
| `REQUEST_EXPIRED`            | ID already ran; its outcome expired; it will not run again | 410  | 1        | VALIDATION |
| `REQUEST_PENDING`            | Accepted and still in progress elsewhere; retry later      | 409  | 4        | RUNTIME    |
| `REQUEST_RECOVERY_CONFLICT`  | Interrupted request's target changed; nothing overwritten  | 409  | 2        | RUNTIME    |
| `REQUEST_CAPACITY_EXHAUSTED` | Request ledger full; rejected before any write             | 507  | 2        | RUNTIME    |
| `REQUEST_LEDGER_UNAVAILABLE` | Request ledger cannot be opened; rejected before any write | 503  | 2        | RUNTIME    |

Where the code appears:

- **REST**: `{ "error": { "code": "REQUEST_ID_CONFLICT", "message": "..." } }`.
- **CLI**: the JSON error envelope code is `VALIDATION`, `BUSY`, or `RUNTIME`
  (exit code above) and the request code is in `details.requestCode`.
- **SDK**: `GnoSdkError` with the request code in `details.code`.
- **MCP**: tool error text `CODE: message`; `structuredContent.error` is the
  code.

See [Troubleshooting](../TROUBLESHOOTING.md#request-id-errors) for recovery
steps per code.

## Who can see a request

| Surface                                            | Namespace                                                                                                                      |
| :------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------- |
| CLI, SDK, stdio MCP, REST (`gno serve`)            | One local-owner namespace per index                                                                                            |
| Resident HTTP MCP (`/mcp` on `gno serve`/`daemon`) | The authorized identity: loopback, or the configured bearer token. Stable across restarts; not tied to session or client name. |

Distinct HTTP MCP identities cannot read, replay, or probe each other's
requests: another identity's ID reads `not_found`, and the same ID under a
different identity is simply that caller's own request. Rotating the bearer
token starts a new namespace, so requests made under the old token can no
longer be looked up or resumed; do not resend an uncertain old write under the
new token as if it were new. Shared credentials share authority; there is no
multi-user authentication layer.

## Storage and retention

Request records live in one private SQLite ledger per index, next to the index
database:

```text
<dataDir>/write-receipts/<index db filename>
```

Per-platform paths and permissions are in
[Write Request Ledger](../CONFIGURATION.md#write-request-ledger).

- GNO never removes the ledger. `gno update`, re-embedding, rebuilding or
  deleting `index-*.sqlite`, and `gno reset` leave it alone; `gno reset`
  removes everything else in the data directory and keeps `write-receipts/`.
- Deleting `write-receipts/` by hand discards replay protection: a request ID
  recorded there could run again as a new write. Include it when you back up
  private GNO state.

- A committed record keeps its full outcome for **30 days**, then is compacted
  to a permanent minimal tombstone. A tombstoned ID returns `REQUEST_EXPIRED`
  (lookup: `expired`) and never runs again.
- The ledger holds at most **100,000** rows (records plus tombstones). When it
  is full, new writes with a request ID are rejected
  `REQUEST_CAPACITY_EXHAUSTED` before anything is written; existing records
  still replay, and writes without a request ID are unaffected.
- There are no configuration options and no cleanup command.
- The ledger holds private recovery data (destination paths, hashes, recorded
  outcomes; a remember outcome includes the fact text). Status lookups, logs,
  and diagnostics never expose it.

## Writes without a request ID

Calls without an ID keep their response shapes, with two points to know:

- **Shared write lease.** Capture on every surface (now including
  `gno capture` and `client.capture()`) and REST document saves plan and write
  under the shared write lease. If another writer holds it past the wait
  window, the call returns the typed busy error and writes nothing. Two saves
  from the same revision can no longer both win: one gets `409 CONFLICT`.
- **CLI and SDK capture keep their sync outcome.** Without an ID,
  `gno capture` and `client.capture()` still succeed (exit 0, a resolved
  receipt) with `sync.status: "failed"` and `sync.error` when the note was
  written but lexical sync failed; run `gno update` to index it. With
  `open_existing` on a file that is not indexed yet, they still return
  `sync.status: "skipped"` ("Existing file is not indexed yet."). MCP and REST
  capture report `CAPTURE_SYNC_FAILED` as before.

A retried write without an ID is evaluated again as a new call:

- **Capture** may create a suffixed duplicate (`create_with_suffix`) or fail
  because the note already exists (`error`).
- **Remember add** returns `existing`, or adds the fact again if it was
  superseded in between. **Supersede** fails `MEMORY_SUPERSEDE_CONFLICT`.
- **Document save** fails `CONFLICT` when `expectedSourceHash` was sent, or
  overwrites a newer edit when it was not.
- A write interrupted after the file landed but before sync can be duplicated
  by a retry.

## Not the same as other receipts

- **Recall receipts** (`receipt` on `recall`, passed back to `remember` for
  context fencing) describe what text was recalled. A request ID identifies a
  write for retries. The two are unrelated.
- **Capture receipts** are the capture result object (provenance, sync, and
  embed state). With a request ID they gain the `request` field above.
- **Browser clipper** writes use the `Idempotency-Key` header, not request IDs.

## Related

- [CLI: gno request-status](../CLI.md#gno-request-status)
- [REST API: request IDs](../API.md#request-ids)
- [MCP: gno_request_status](../MCP.md#gno_request_status)
- [SDK: request IDs](../SDK.md#request-ids)
- [Memory: retries](../MEMORY.md#retrying-a-remember)
