# Durable receipts for safe mutation retries

## Goal & Context

<!-- scope: business; source: paraphrase -->

Let a caller recover the outcome of an accepted write after losing its response, without creating a duplicate capture, superseding a fact twice or overwriting a newer document. Preserve GNO's existing leases, content deduplication, predecessor hashes and optimistic document updates. Establish failure evidence first and add only the durable request bookkeeping necessary for supported mutations.

Scope the initial mutation set to capture create/update, remember add/supersede, and document update. Session import keeps its own source checkpoint/idempotency contract; do not force every background operation onto a new general job framework.

## Architecture & Data Models

<!-- scope: technical; source: inferred -->

Create a bounded durable mutation receipt contract keyed by stable trusted caller namespace, selected index and caller-supplied opaque request ID. Bind it to a canonical operation digest including semantic payload, destination, expected source/predecessor revision and scope. Exclude transport noise. Current transient session IDs alone cannot be the replay identity because retries may reconnect after a restart. Define authority according to the current product, without introducing a multi-user auth layer:

| Surface                         | Trusted receipt namespace                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI, local SDK, stdio MCP, REST | One local-owner namespace per stable index identity; caller/session strings are provenance, not distinct authenticated principals. Existing transport admission still applies. |
| HTTP MCP                        | Its authorized identity, either loopback or the configured bearer-token digest, plus index identity; exclude serverInstanceId and clientName.                                  |

Distinct-principal non-disclosure/revocation tests apply to distinct HTTP MCP identities, not fictional users of the shared local-owner surface. Shared credentials share authority. Token rotation creates a different namespace; old receipts cannot be read or resumed under the new identity, and clients must not automatically resubmit an uncertain old mutation as a new intent.

Use one shared admission/replay service across the scoped CLI/MCP/REST/SDK write entrypoints, backed by one private durable SQLite receipt ledger per stable index identity in the GNO configuration/state area, outside the disposable index database. Index rebuild/reset does not erase receipts or tombstones. No new authorization registry is needed. Atomically insert the unique namespace/request-ID admission before executing a mutation and retain enough private recovery information to reconcile file publication, lexical sync and terminal completion under the existing write lease. Define terminal success per operation:

| Operation                    | Canonical committed boundary                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Remember add / supersede     | File plus lexical sync; supersede additionally requires the edge projection, preserving the existing contract.                                                                                                                                         |
| Leased capture create/update | Archive/note publication plus lexical sync. The legacy asynchronous 202 clipper route is excluded from request-ID support in this slice and must reject an offered request ID rather than silently ignore it.                                          |
| Document update              | Source file published and its new sourceHash durably recorded in the receipt; lexical sync and embeddings are separately reported deferred work. Failed deferred sync does not undo a committed file save; expose the existing update/recovery action. |

All scoped document-update entrypoints route their revision-check/publication critical section through the existing shared write lease, including calls without request IDs, so a legacy writer cannot bypass serialization and overwrite an opted-in edit. Preserve existing response shapes and asynchronous save completion; contention returns the documented typed busy error. Request-ID convergence comes from unique admission plus the shared lease, not a second lock hierarchy. SDK capture paths use the shared leased publication service rather than a duplicate write implementation. Embedding or other deferred work remains separately visible. A durable accepted receipt survives restart. A pre-admission rejection is not accepted work and is retryable only as documented.

Replay decision sketch, internal only:

```ts
type SavedRequest = { digest: string; terminal: boolean };
function decideRetry(
  saved: SavedRequest | undefined,
  incomingDigest: string
): "admit" | "replay" | "pending" | "conflict" {
  if (!saved) return "admit";
  if (saved.digest !== incomingDigest) return "conflict";
  return saved.terminal ? "replay" : "pending";
}
```

Lookup occurs within the trusted owner/index namespace. Digest comparison alone does not authorize access. Replaying a terminal request returns its retained outcome and never re-executes the side effect. For unfinished work, reconcile recorded identities/hashes before retrying; ambiguity returns a recoverable pending/conflict state rather than guessing.

## API Contracts

<!-- scope: technical; source: inferred -->

Add an optional request ID and receipt lookup contract consistently to the scoped mutations. Preserve the existing behavior of clients that do not opt in, explicitly documenting their weaker response-loss guarantees. Legacy document saves gain the same short publication lease but no receipt bookkeeping; their deferred-sync boundary stays unchanged. Keep request receipts distinct from existing recall anti-replay receipts and capture provenance receipts. Publish schemas and error/exit mappings before implementation, including admitted/pending/committed/failed/conflict semantics and the exact retention/replay guarantee.

Retain bounded full receipts with a documented time/storage policy. Compact expired full receipts to a permanent minimal namespace/request-ID/digest tombstone and return one expired-receipt refusal on reuse; eviction must never turn an old committed request ID into a fresh mutation. Exhausted durable capacity rejects new admission before side effects rather than deleting replay protection. Use one fixed ledger capacity bound and one typed capacity error before admission. No configurable retention framework or new administrative cleanup API is part of this slice. The ledger is included in documented private state backups and is never removed by ordinary index maintenance.

| Surface    | Required scope                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI        | Opt-in request IDs for capture/remember/document-update where exposed; receipt status/recovery commands and typed pending/conflict output; do not blindly retry a new ID.                                    |
| MCP        | Shared write request and bounded receipt lookup schemas, with identity mapped from the connection; preserve existing write opt-in and conservative tool annotations.                                         |
| SDK / REST | Typed request IDs and receipt retrieval across reconnects, stable conflict/pending errors and authorization; current optimistic source/predecessor checks remain required where already used.                |
| Web UI     | Retain one request ID while retrying the same submitted edit/capture/memory action; show pending/committed/conflict and recovery without duplicate-submit ambiguity. A changed payload creates a new intent. |
| Skills     | Teach saving request IDs, checking before retrying, distinguishing write receipts from recall receipts, and resolving stale-revision conflicts by re-reading.                                                |
| Git docs   | Update write/capture/memory/editing, CLI/MCP/API/SDK/Web UI, concurrency/recovery, storage retention and troubleshooting documentation plus schemas.                                                         |
| gno.sh     | Mirror retry/idempotency and recovery guide/reference, relevant feature promises and FAQs; accurately separate canonical success from pending embeddings.                                                    |

## Edge Cases & Constraints

<!-- scope: technical; source: inferred -->

First reproduce and document response-loss behavior of the existing operations; reuse existing safe idempotency mechanisms rather than stacking redundant locks. Exercise crashes before admission, after admission, after file publication, after lexical sync and before response delivery. Reconcile partial writes without overwriting unexpected local edits. Scope changes/revocation apply at lookup and before pending work executes; another caller must not learn whether an inaccessible request exists.

Same ID with different payload, destination, revision or operation conflicts. Concurrent identical requests converge to one outcome. A replay after a document was removed/recreated cannot mutate the new document. Malformed/oversized IDs fail before admission. Protect private recovery payloads outside ordinary logs/repos and bound retention without exposing source contents through status. Cancellation states distinguish rejected, accepted-but-pending and completed work honestly.

## Acceptance Criteria

<!-- scope: both -->

- **R1:** [inferred] Capture failure-injection evidence for each scoped mutation's existing response-loss/retry behavior and identify the smallest missing guarantee. Errors: no speculative global coordinator or duplicate locking when the existing path already satisfies an invariant.
- **R2:** [paraphrase] An opted-in accepted mutation has a durable scoped request identity and an inspectable outcome across reconnect/restart. Errors: admission/storage failure occurs before side effects and cannot report accepted; current authority is checked before revealing receipt contents.
- **R3:** [inferred] Identical retries return the retained outcome or pending status, while changed operation/payload/scope/revision conflicts. Errors: concurrent submissions, reused IDs, cross-caller probes and reconnect identity changes cannot execute twice or leak another caller's state.
- **R4:** [paraphrase] Recovery preserves canonical files, lexical state, existing optimistic checks and newer edits at every tested interruption boundary. Errors: unexpected file hashes, stale predecessors, deletion/recreation and failed sync remain typed recoverable failures; embedding backlog cannot be reported as canonical write failure after commitment.
- **R5:** [inferred] Bounded retention and compaction preserve replay refusal for old identities and reject capacity exhaustion before mutation. Errors: expired receipts cannot silently admit old requests anew; private recovery data never appears in public diagnostics.
- **R6:** [paraphrase] CLI/MCP/SDK/REST/Web UI clients preserve the same request ID across retries of one intent and expose pending/conflict/committed states correctly. Errors: browser refresh, lost responses and stale edits never trigger silent force-overwrite; clients without IDs retain their response shape and completion boundary, with the explicitly added publication lease/busy outcome.
- **R7:** [inferred] Deterministic fault tests plus separate-process crash/concurrent-caller tests prove one side effect per admitted request and stable replay results; rerun the existing memory gate and affected capture/editing contracts. Errors: count real durable side effects and read-back state, not mocked handler invocation counts; no LLM quality eval is needed for this persistence change.

**Documentation and delivery obligations.** [paraphrase] Complete the topic-specific documentation work listed in the surface matrix as part of this feature, across the two canonical documentation surfaces: repository Markdown rendered by Git hosting, and `gno.sh`. Update affected README capability/setup examples, changelog, user guides, CLI/MCP/API/configuration reference, architecture explanation, interface specs and structured-output schemas. Keep examples executable and distinguish defaults, opt-ins, unsupported cases and recovery behavior. Update the shipped GNO skill and relevant reference files, connector/harness instructions, and installed-skill verification. Do not create a third documentation site or update the retired in-repository website pages.

For `gno.sh`, update the matching docs/reference pages, relevant product/feature and install pages, FAQs and any affected comparison claims. Register new docs in navigation and prerender/sitemap routes. Verify the HTML and its generated Markdown twin, `/llms.txt`, `/llms-full.txt`, and alternate-format links agree; do not maintain divergent copies. Preserve local-only privacy promises and accurately state any new writes or background behavior. Keep internal eval fixtures, raw diagnostics and design notes out of public user documentation; public docs explain supported behavior and reproducible limits.

**Verification and delivery gates.** [inferred] Run focused regression and schema tests, then `bun run lint:check`, `bun test`, `bun run docs:verify` and documentation/public-truth checks appropriate to the changed scope. Run the topic-specific evals specified in the acceptance criteria; freeze models, fixtures, settings and thresholds before comparing arms, retain negative results, and never lower a threshold to pass. Where CLI/MCP behavior or shipped skill instructions change, run the GNO skill autoresearch eval, reconcile the shipped skill/reference sources and verify installation. Exercise changed CLI/MCP/REST/SDK behavior through actual invocations; drive changed Web UI flows with screenshots/responses, including keyboard and mobile behavior. A build or source inspection is not live QA.

For the hosted site run `bun run check`, `bun run typecheck`, `bun run build` and affected tests, then drive the changed pages locally, including navigation, copy buttons, Markdown twins and narrow width. Keep the GNO and hosted-site changes linked for coordinated delivery. When deployment is authorized, deploy from the canonical site repository and verify production HTTP response, service health, deployed revision, and the changed live pages. Do not claim production verification before deployment. Product publication follows the separately authorized release workflow. Record applicable gates and evidence in the spec completion record, including any blocked external delivery.

## Boundaries

<!-- scope: business -->

- [inferred] No distributed consensus, multi-host file ownership, automatic failover, general workflow engine or synchronization of index databases.
- [inferred] No receipt-led privilege widening, automatic force overwrite, new default destructive operation or unsupported exactly-once claim for external side effects.

## Decision Context

<!-- scope: both -->

- [inferred] Content deduplication and revision guards solve different problems from recovering the outcome of one admitted request. Failure evidence determines where the extra ledger is necessary.
- [inferred] A single-host durable receipt layer fits the existing local-first architecture. It must remain smaller than a general distributed writer coordinator.
- [inferred] Maintainability (plan review): duplication - all scoped write entrypoints call the same admission/replay service and shared publication lease; preserve operation-specific completion boundaries explicitly. Structure - one private ledger with expiry, minimal tombstones and one hard cap, without a new cleanup API or identity framework.
- [inferred] Session import/automation have independent checkpoint/job contracts and do not depend on this spec unless implementation evidence demonstrates a shared required seam.
