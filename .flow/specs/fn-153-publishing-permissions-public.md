# Publishing permissions, public revocation, and a usable Studio

## Goal & Context

A publisher must be able to choose who can read an export, review or override that choice on gno.sh, update an existing publication, and withdraw or delete it without operator assistance. Studio should make content and publication state understandable. The hosted reader should make its note navigation visibly interactive.

This is a cross-repository implementation spec. GNO lives in `~/work/gno`; the hosted product lives in `~/work/gno.sh`. Flow state stays in GNO. Work begins after the other agent's GNO 2.0 release is complete. Refresh both repositories from the released baseline before implementation; do not build against this conversation's older deployment. fn-154 tracks the release gates, but its task completion alone is not proof that the release has shipped.

Gordon authorized preparing both specs for a fresh implementation agent on 5 September 2026. The decisions below replace the earlier capture assumptions and unfinished interview alternatives. Keep this spec no-plan with zero tasks; it supports direct execution through `$flow-next-work fn-153` after the release prerequisite. This handoff does not authorize changing real publications or deploying production.

## Architecture & Data Models

### Repository entry points

| Surface | Files to inspect first |
|---|---|
| Local export UI | `src/serve/public/pages/DocView.tsx`, `src/serve/public/pages/Collections.tsx`, `src/serve/public/lib/publish-export.ts` |
| Local export contract and implementation | `src/publish/export-service.ts`, `src/publish/artifact.ts`, `src/publish/encrypted-export.ts`, `src/cli/commands/publish.ts`; locate `/api/publish/export` in `src/serve` |
| Hosted Studio and mutations | `src/components/studio/publish-studio.tsx`, `src/lib/publish.functions.ts`, `src/lib/publish-service.ts`, `src/lib/publish-mutation-adapter.ts` in gno.sh |
| Artifact import | `src/lib/publish-artifact-client.ts`, `src/lib/publish-artifact.ts`, `src/lib/publish-import.server.ts`, `src/lib/server/publish-db-import-write.ts` in gno.sh |
| Source, target, and access persistence | `db/schema.sql`, `src/lib/server/publish-db-source.ts`, `publish-db-read.ts`, `publish-db-write.ts`, and repository adapters in gno.sh |
| Access, entitlement, and asset delivery | `src/lib/server/entitlements.ts`, `billing.ts`, `src/lib/publish-reader-asset-delivery.ts`, `publish-artifact-asset-lifecycle.ts`, `src/lib/server/storage.ts` in gno.sh |
| Reader navigation | `src/components/reader/reader-scaffold.tsx` and its styles in gno.sh |
| Policy and documentation | `docs/WEB-UI.md`, `docs/API.md`, `docs/CLI.md`, `spec/cli.md` in GNO; `src/lib/gno-docs.tsx`, `src/routes/terms.tsx`, `privacy.tsx`, `src/lib/legal.ts` in gno.sh |

Paths are starting points verified during preparation; inspect the released implementations before editing. Preserve the repository's existing service/repository split and production/fallback behavior. Do not implement only the in-memory demo path.

### Access selection

| Input | Initial choice | Publication rule |
|---|---|---|
| Local Web UI export, no hosted account context | No mode selected | Require explicit choice; explain current hosted plan availability without pretending local GNO knows the account |
| New Markdown/text or source publication in Studio | Secret-link if entitlement allows private publishing; otherwise public | Show the mode and audience in review, then require Publish |
| Uploaded artifact | Preserve each space's declared mode | Allow supported explicit overrides; an unavailable mode requires a deliberate supported choice or upgrade, never automatic public fallback |
| Existing publication update | Preserve current mode and link unless the user explicitly chooses an access change | Review both the existing and proposed state before committing |

Use the existing entitlement source, not duplicated plan checks. Current private publishing is paid; encrypted publishing has its own entitlement. Show free/paid availability in local help from a maintained shared contract or documented metadata, and direct the user to hosted pricing for the account-specific decision. Preserve explicit CLI/API defaults for backward compatibility.

### Visibility conversions

Public, secret-link, and invite-only can convert among each other. Rebuild access records and public projections from the effective mode. Invite-only must show the intended owner/organization audience and use the existing membership/access model. Owner access alone is the explicit default for a personal invite-only share unless recipients are selected.

Any transition into or out of encrypted mode requires a new local export in that mode. The hosted service never receives a passphrase or decrypts a share. An encrypted artifact may be published unchanged and updated with another correctly encrypted artifact. Do not reuse plaintext access-edit or append paths for encrypted content.

A content-only update preserves its active route, token, and mode. An access-mode change invalidates the old access path/token before the new mode becomes visible. Public-to-private conversion returns 404 on the old public routes; secret-to-invite conversion invalidates the old secret token. A stale operation must not resurrect broader access. A previously withdrawn public URL must not silently reactivate on a later private-to-public conversion; allocate a fresh public route in that case. Existing public content can still update at its active URL.

### Source library and publication lifecycle

Keep source content and publications as separate concepts, with an explicit association. Studio opens with a compact library of content items. Each row shows title, note/collection type, note and asset counts, current access when published, and status. Publish opens the upload/review flow. Item details expose publication history and advanced options without a second unexplained ledger.

Use these visible states as appropriate: Draft, Published, Unpublished, Expired, Deleting, Cleanup failed. A later moderation state is owned by fn-155. A retained source must explain that it can be published again; an unpublished target must remain discoverable in its owner's history. Raw snapshot identifiers belong in expandable diagnostics, not the primary row.

Distinguish three operations:

- **Update publication:** explicitly choose the matching target, preview the replacement, and preserve its active access for content-only updates. A matching filename or slug alone never authorizes overwrite.
- **Publish a copy:** create a separate source/target with a distinct route, after explicit choice. Do not silently make a second public copy.
- **Unpublish / Delete permanently:** unpublish denies hosted access but retains source and history; deletion removes the selected hosted library item, its associated publications and history, and unreferenced payloads. Local vault files remain untouched.

If an uploaded multi-space artifact cannot be reviewed and applied atomically, reject it before writes with a clear supported path. The first implementation may explicitly block mixed-mode or multi-space updates rather than partially publishing them. Existing append support belongs under advanced options, with a selected target and preview; reject unsupported encrypted or access-conflicting appends.

### Deletion and persistence

The confirmation names the selected item and counts the publications, snapshots, and assets affected. For a collection, delete that imported collection and its history; preserve separately published notes/copies and objects still referenced elsewhere. Show this limitation before confirmation. Do not implement cross-vault or cross-owner deletion.

In one database transaction, mark the selected source/targets deleted, deny access, and persist a cleanup job. Only then return Deleting. Clean database content and object storage asynchronously with idempotent retries. Refresh/restart must retain job state; a storage failure leaves access denied and shows Cleanup failed with a retry action. The job reaches Deleted only after all in-scope live payloads and derived projections are gone. An absent object is successful cleanup. Derive object keys from trusted persisted references and reference counts, never client-supplied paths.

Use the smallest durable worker mechanism compatible with the deployed service, including startup recovery and a documented retry command. Do not add a new queue dependency solely for this feature. Keep only the minimal content-free operation receipt needed for idempotency; do not retain title, body, assets, or secret tokens in it. Deletion must not erase fn-155 moderation tombstones or any explicitly recorded legal hold. Such exceptions must have restricted access and truthful policy treatment; do not invent or automatically create legal holds.

Enforce denial in the shared read path for every visibility, historical snapshot, reader route, search/discovery result, public Markdown/manifest/llms projection, and asset route. Application-controlled caching must not serve withdrawn content after success. If an existing signed object URL can outlive revocation, change delivery or bound/invalidate it before claiming the criterion passed. Already downloaded copies cannot be recalled.

## API Contracts

Extend the existing endpoints/server functions rather than creating a parallel publishing service. Update GNO's interface specs and schema tests before changing its output contracts.

- Export accepts target and visibility, plus local encryption input only when required; the artifact and result report the selected mode. Preserve v1 plaintext and v2 encrypted contracts and bundled-asset validation.
- Hosted publish accepts the validated artifact, per-space effective access where supported, operation intent (new, update, copy, or supported append), target identity for mutations, and an expected revision. Return effective access, resulting route, target identity, and new revision. Unknown fields, conflicting intents, unsupported conversions, and entitlement failures are rejected before activation.
- Content or access edits, unpublish, and deletion validate server-side owner scope and expected revision. Use transaction locking or compare-and-swap to reject stale changes. Unpublish and delete accept a stable idempotency key and return their actual state. No mutation is allowed via GET.
- Use existing typed error conventions with distinguishable validation, unauthorized/not-found, entitlement, conflict, and cleanup-failure outcomes. The UI retains the draft and shows the relevant correction. Do not expose another tenant's existence through errors.
- Readers deny inaccessible/deleted content with the existing non-disclosing not-found response. Owner management views can show the reason without exposing content to readers.

## Edge Cases & Constraints

Test public, secret-link, invite-only, and encrypted publications, both personal and organization ownership. Organization mutation authorization is the existing publishing authority, not merely reader membership. Egress Policy, ownership, entitlement, and visibility are independent checks; an override cannot relax the others.

Handle legacy imports with missing provenance, targets with a null latest-snapshot pointer, and public snapshots whose old code bypassed revocation checks. Add an explicit source-to-target association where needed. If an association is ambiguous, require target selection; do not infer destructive ownership from a title match.

Repeated clicks, browser retries, update-versus-unpublish races, delete-versus-publish races, and token rotation must not restore access. Failed transactions leave the prior publication intact; after a committed withdrawal, subsequent cleanup failures leave it inaccessible. A new explicit publish from an unpublished retained source may create a fresh publication, but a deleted source cannot be republished through a stale request.

The shared denial model must allow an independent operator moderation block in fn-155; owner mutations cannot clear that future block. Keep this extension small, with no moderation UI in fn-153.

## Acceptance Criteria

- **R1:** Note and collection export dialogs require an explicit access choice and export that mode. Invalid choices, cancelled dialogs, and missing encryption inputs produce no artifact. [paraphrase]
- **R2:** Import review shows each supported space's declared and effective access, accepts supported overrides, and publishes exactly the reviewed result. Unsupported multi-space combinations are rejected before any activation. No ignored override or silent public fallback. [paraphrase]
- **R3:** Export/import/edit preserve entitlement, tenant ownership, Egress Policy, invite membership, and client-encryption boundaries. Unsupported encryption conversions give a local re-export path and create no publication. [paraphrase]
- **R4:** Owners can unpublish every mode, including public. Subsequent reader, asset, search, historical, and machine-readable requests cannot serve the withdrawn content; retries and concurrent writes do not reactivate it. [paraphrase]
- **R5:** File selection creates a draft. Review precedes explicit publication; failed validation preserves the draft, and duplicate submissions do not create duplicate publications. Matching content requires an explicit update-or-copy decision. [paraphrase]
- **R6:** Studio distinguishes retained sources from active, unpublished, expired, and deleting publications. Summaries contain readable text and word-safe truncation. Status and relevant failures remain visible across refresh. Desktop, mobile, and keyboard journeys are usable. [paraphrase]
- **R7:** Every export/publish review explains the audience and requires deliberate confirmation. The earlier universal secret-link default is withdrawn; R9 and the access-selection table define the effective defaults. [paraphrase]
- **R8:** Reader Contents rows have visible full-row hover, keyboard focus, and persistent current-note selection, with distinguishable states, readable contrast, and no layout shift. Verify real pointer, keyboard, note switching, and touch behavior. [paraphrase]
- **R9:** Studio defaults new content to secret-link when entitled and public otherwise; uploaded artifacts preserve their declared access. Local export without account context starts with no selected mode. Unsupported access requires explicit correction, never a silent downgrade. [paraphrase]
- **R10:** Confirmed owner deletion immediately denies access, then durably cleans the selected hosted source, associated publication history, and unreferenced assets. Independent copies and shared objects survive. Failures remain denied, visible, retryable, and recoverable after restart. [paraphrase]
- **R11:** Studio opens with the compact library and prominent Publish action. Item details contain history and advanced operations; a missing ledger row is never the sole indication of withdrawal. [paraphrase]
- **R12:** Ordinary content updates preserve active links. Access changes invalidate superseded routes/tokens, and stale operations cannot restore them. Encryption conversion requires local re-export. [paraphrase]
- **R13:** Terms, Privacy, publishing help, and GNO export/API documentation accurately describe the implemented modes, unpublish versus deletion, cleanup status, independent copies, and limits on recalling content. Remove obsolete claims that public deletion is not self-service. Policy and product changes ship together; no unsupported GDPR or universal erasure claim. [user]
- **R14:** Production database/object-storage tests and running-app QA cover migration, permission changes, revocation, deletion recovery, and reader navigation. Green unit tests or source review alone do not satisfy release acceptance. [inferred]

## Boundaries

Includes GNO local export, hosted import and lifecycle, Studio, reader navigation feedback, and affected policy/docs. No account deletion, billing redesign, new permission mode, whole-site redesign, or global egress-policy changes. fn-155 owns abuse reporting, operator moderation, and its policy disclosures.

A spec commit authorizes no new production mutation. Development uses synthetic fixtures; production release and any operator configuration follow Gordon's existing approval boundaries. Never reuse the real note or secret token from this conversation as a test fixture.

## Decision Context

Gordon reported public-by-default local export, an import selector that ignored uploaded JSON access, inability to revoke public content, a retained source with no corresponding ledger entry, raw Markdown/truncated summaries, and reader links with no apparent hover feedback. The screenshot documents the surface but cannot prove an absent hover state; verify it live.

The incident was remediated separately by disabling the exact public target. That operator workaround is historical evidence, not the implementation design. No further action on that publication is part of this spec.

Confirmed interview choices include plan-aware defaults, owner deletion, library-first Studio, editable ordinary visibility, invalidation when access tightens, and separate abuse work. For this implementation handoff, the agent selected the remaining routine UX defaults under Gordon's instruction to make the specs ready: preserve artifact access, explicit update-or-copy, stable content-update links, immediate denial with durable cleanup, and deletion scoped to the selected item. These are design decisions, not additional quotations from Gordon.

## Strategy Alignment

Explicit access and withdrawal support Controlled portability. Consistent local export and hosted import support Coherent agent and application surfaces. No strategy conflict identified.

## Verification and Documentation

Use GNO's `test/serve/routes/publish-export.test.ts`, `test/cli/publish-export.test.ts`, and `test/publish/` as regression entry points. In gno.sh, extend Studio, publish service/import/access, reader delivery, and PostgreSQL/object-storage integration suites. Include a two-owner fixture, organization reader versus publisher, public collection with images, every visibility, and fault injection during deletion.

Run the required GNO checks (`bun run lint:check`, `bun test`) and site checks (`bun run check`, `bun run typecheck`, `bun run test`, `bun run test:integration`, `bun run build`) as applicable to the final changes, verifying current scripts first. Run GNO locally and gno.sh at port 3344. Drive export -> upload -> review -> publish -> content update -> access change -> unpublish -> deletion, including stale requests, storage failure/retry, restart, and shared-asset preservation. Capture screenshots/responses for desktop and mobile, keyboard focus and pointer hover. Follow `$flow-next-qa fn-153` and each repo's AGENTS.md; a missing running app is a blocker, not a pass.

Update both `terms.tsx` and `privacy.tsx` for public self-service removal. Explain retained unpublished sources, pending/failed cleanup, local-versus-hosted deletion, independently published copies, and copies already downloaded. Do not promise instant backup erasure. Inspect the deployed backup/restore policy during release preparation and ensure deleted content cannot become publicly active after restore; disclose actual residual retention rather than inventing a duration. Keep the encrypted-content promise intact. Update `src/lib/legal.ts`'s effective date only when the revised policies ship. fn-155 extends these pages afterward and must preserve this deletion wording.

Ship a migration and rollback runbook. An application rollback must not return to a reader version that ignores deletion/revocation state; retain a compatible denial guard or disable affected publishing readers. Walk the required downstream docs chain, and recheck the changed site pages after an authorized deployment. Record exact tested commits and remaining release prerequisites in the handoff.
