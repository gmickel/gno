# Reader reading time, total views, and Markdown copy

## Conversation Evidence

> Gordon: "a) reading time per page"
> Gordon: "b) how many unique people have read it (simple number, no other tracking), no use of cookies etc and no perf degradation"
> Gordon: "c) a copy to markdown button and shortcut for pasting into agents"
> Gordon: "not sure, but gno.sh runs on hetzner and that gives us full control of the stack, we have a database right. why do we need to store anything?"
> Gordon, after total page views without visitor identification were proposed: "then its really simple yea?"
> Gordon, after the three-feature total-views scope was restated: "ok capture that spec to as no-plan, make sure it's ready for a fresh agent too"

## Goal & Context
<!-- scope: business; source: paraphrase -->

Readers of hosted gno.sh notes can estimate the time needed to read a page, see its total view count, and copy its Markdown into an agent. Keep the UI compact and the implementation small. Total page views replace the initial unique-person request; the number represents page opens, not distinct people or completed reads.

This feature extends the hosted reader shared by public, secret-link, invite-only, and encrypted publications. fn-153 owns the Studio/lifecycle/navigation revamp; this spec adds reader utilities on that foundation. fn-155's moderation work is separate. No additional local GNO export feature is required.

## Architecture & Data Models
<!-- scope: technical; source: inferred from inspected implementation and accepted scope -->

### Reading time

Show a compact estimate beside the note metadata, for the current note only. Use visible prose word count at 200 words per minute, rounded up to whole minutes with a minimum of one minute for nonempty text. Exclude frontmatter, Markdown syntax, code blocks, navigation, URLs, and image binary payloads; count link labels and table text. Hide the estimate for an empty note. This is an estimate, not a measurement of reader behavior.

Derive from the same content the reader displays. Compute once per note revision and reuse it; do not parse the whole document on scroll or each render. For encrypted notes, compute only in the browser after successful decryption, without sending plaintext or derived word counts to the server. Use existing text-processing utilities where suitable; do not add a package solely to count words.

### Total page views

Persist one aggregate nonnegative counter per hosted note identity. Associate it with the owner's publication target and stable note identity, not a secret token, raw URL, or snapshot version. A normal content update, visibility change, or slug change preserves the count; a separately published copy starts at zero. Deletion removes its counter through fn-153's cleanup. Unpublish, expiry, and moderation deny access to counts alongside content.

Count once when a note is successfully displayed during a real reader navigation. Refresh and a later return to the same page count again. A React rerender, prefetch, duplicate hydration, search, asset request, raw Markdown download, failed access, owner Studio preview, or encrypted unlock failure does not count. Navigating between notes in a collection counts the displayed note; opening the collection root counts its home note once. Use a component/navigation-local guard only, never persistent browser storage.

Use a small first-party signal after successful display, without delaying the reader. Resolve the authorized target/note on the server and recheck ordinary access and withdrawal state. Where a private-mode request needs existing access credentials, use the normal authorized channel without persisting those credentials in analytics. Do not use account IDs, session cookies, IP addresses, user agents, hashes, fingerprinting, localStorage, sessionStorage, or visitor identifiers for counting or deduplication. Existing authentication cookies remain authentication only.

The aggregate is deliberately approximate. A blocked signal, crash, or temporary outage may lose increments. Refreshes and automated browser visits may inflate it. Do not build visitor identification, bot fingerprinting, fraud scoring, or exactly-once event storage to make it look exact. Label the UI `views`, with accessible help explaining page opens and possible reporting delay.

### Background updates and performance

Accumulate deltas by note in bounded process memory and flush batches to the existing database with atomic increments. Use a short interval (default five seconds), bounded batch size and pending-note capacity, and at most one flush per process at a time. Detach the batch before writing so increments arriving during a flush are not lost. Multiple workers must add deltas rather than overwrite totals.

On a definite database failure, requeue within the memory bound. On an ambiguous commit outcome, discard the uncertain batch rather than blindly retrying and double counting. Drop excess pending analytics under sustained failure and keep serving content. Flush best-effort on graceful shutdown, with a bounded timeout; a crash may lose the unflushed batch. Do not introduce a durable per-view event queue, new service, or third-party analytics SDK.

Display cached totals or load the count after content is visible. Neither a count read nor write may block content delivery, navigation, decryption, or Markdown copy. Cache entries must remain owner/target scoped and respect access checks. A cold/unavailable count displays no misleading zero; hide it or show a quiet unavailable state. Reserve layout space to avoid shifts.

The current reader service awaits analytics writes and records referrer buckets; some paths pass a secret token as a route identifier. Replace these published-reader analytics calls with the aggregate-only path. Stop adding referrer or secret-route records, and prevent double counting through the old and new paths. Existing historical analytics is not a per-note total and must not be relabeled as one. Start the new counters at zero at rollout; document when counting began. Handle any cleanup of historical records through the existing retention process rather than silently deleting production data.

### Copy Markdown

Add a clearly named Copy Markdown button, separate from Copy link. Copy the current note's readable Markdown with its title exactly once, preserving headings, lists, tables, code fences, and meaningful links. Exclude frontmatter/internal metadata, reader navigation, view counts, reading-time labels, and other notes in the bundle. Prefer canonical note Markdown where available; otherwise use a tested serializer for supported reader blocks, not rendered DOM text.

Do not append a secret share URL, access token, session data, or decrypted credentials. Preserve authored external links. Resolve public image references to usable public URLs; for protected or browser-only assets, retain descriptive alt text with an explicit nonportable-image placeholder instead of copying blob URLs, internal asset sentinels, credentials, or base64 payloads. This copies text, not attached binary assets.

Support public/secret/invite content only after the normal reader authorization. For encrypted notes, copy the successfully decrypted current note entirely in the browser; never request a server plaintext projection. The action is explicit and must not automatically send the clipboard to an agent.

Use Shift+Y as the default shortcut, alongside the reader's existing Y copy-link shortcut. Ignore typing/editable contexts, composition, held-key repeats, and Ctrl/Meta/Alt combinations; do not override browser copy or developer shortcuts. Expose the shortcut in the button/help and make it disableable with the reader's single-character shortcuts for accessibility. Preserve existing reader navigation keys.

Clipboard success is announced only after the write resolves. On denial or unsupported clipboard access, show an actionable error and a selectable Markdown fallback. The button remains usable on touch devices. Clear temporary decrypted fallback content when the note is locked, changed, or unmounted.

## API Contracts
<!-- scope: technical; source: inferred -->

- A view signal identifies only the current target and note through the existing authorized reader context. It accepts no arbitrary count/delta, visitor metadata, referrer, or client-selected owner. Validate access and supported request origin; invalid or unavailable targets do not increment. The collector stores only aggregate deltas and never logs access credentials.
- The count read returns only the current note's aggregate count (or unavailable), after equivalent content authorization. It exposes no lists of visitors, daily records, referrers, or cross-note history.
- Reading time and copied Markdown are derived from content already authorized for display. No new unauthenticated plaintext endpoint or private agent API is introduced.
- Use the site's existing request validation and error conventions. Analytics failures are isolated from the reader; errors do not create content or count disclosure across owners.

## Edge Cases & Constraints

A count identifies page opens, not unique readers, sessions, human attention, or reading completion. No deduplication across visits is attempted. [paraphrase]

Metadata-only and empty notes, large code-heavy notes, tables, non-Latin text, notes whose title is already an H1, collection home aliases, and encrypted notes need deterministic handling. Document the word-count heuristic's language limits without adding language detection or model calls. [inferred]

The deployment uses an existing database and a controlled Hetzner stack. Reuse that infrastructure; the feature does not need visitor storage or a new external service. [paraphrase]

Performance means no measurable reader regression, not literally zero CPU or network work. Verification below defines a bound; a failed measurement must be fixed rather than dismissed because counting is asynchronous. [inferred]

## Acceptance Criteria

- **R1:** Each nonempty current note shows a deterministic reading-time estimate based on its visible prose. Empty notes omit it; encrypted notes derive it client-side after unlock. Updates invalidate the cached estimate. [paraphrase]
- **R2:** The reader shows one total-views number per note, with truthful page-open semantics. A displayed navigation increments once; refresh/return increments again; prefetch, rerender, failed authorization, and failed decryption do not. Counts survive updates and start at zero for new copies. [paraphrase]
- **R3:** Counting uses no visitor identifiers, analytics cookies/browser storage, IP/UA records or hashes, referrer breakdowns, or third-party tracking. The new published-reader path stores only aggregate note counts and removes the old blocking/referrer analytics calls from that path. [paraphrase]
- **R4:** Bounded background batches use atomic increments and cannot block or break reading. Concurrent flushes, database failure, full buffers, and shutdown are tested; uncertainty remains a documented approximation, not a claim of exactly-once counting. [inferred]
- **R5:** Copy Markdown and Shift+Y copy only the authorized current note with preserved structure and one title. Errors show a selectable fallback; protected images have explicit placeholders; encrypted copying remains client-only. Button, shortcut, focus, and status announcements work by keyboard and touch. [paraphrase]
- **R6:** Reader access, count access, and view ingestion respect tenant ownership and fn-153 withdrawal/deletion, plus fn-155 moderation when present. No secret token, internal sentinel, unrelated note, or server-decrypted content leaks through these features. [inferred]
- **R7:** Live QA, failure tests, and before/after performance evidence pass. Publishing help and Privacy describe aggregate views, no unique-reader claim, approximation, and actual data handling; they do not promise removal of essential authentication or unrelated security logs. [inferred]

## Boundaries

- Hosted reader only; no Studio/account dashboard redesign beyond what fn-153 already covers. No collection-wide total, engagement analytics, visitor profiles, unique counting, funnels, referrer reports, read receipts, tracking SDK, or new billing restriction. [paraphrase]
- No whole-bundle clipboard export, image-byte copying, new publication mode, or relaxing access/encryption boundaries. [inferred]
- Retain existing required authentication and operational security logging. This feature must not repurpose those records for identifying visitors. [inferred]

## Decision Context

Gordon initially asked for unique people, then questioned why visitor data was necessary. After the difference between uniqueness and an aggregate count was explained, he accepted the simpler total-views scope and requested a separate no-plan spec ready for a fresh agent. [paraphrase]

A small delayed aggregate is enough for the product. Bounded loss under failure is preferable to a tracking system or reader downtime. The five-second batching default, reading-speed heuristic, Shift+Y shortcut, protected-image fallback, and validation details are implementation choices supplied to make the handoff executable. [inferred]

Markdown copy supports deliberate reuse of published knowledge in agent workflows. It preserves the existing content boundary and does not automatically send data anywhere. [strategy:Controlled portability]

## Verification and Handoff

Implement in the hosted gno.sh repository using its existing reader, publish read service/telemetry, Markdown/agent projection, and database layers. Flow tracking remains in GNO. Depend on fn-153 so the common lifecycle behavior and reader changes are available; fn-155 is not a prerequisite. Inspect current code rather than assuming this conversation's baseline is unchanged. No remaining product decision requires another interview.

Test word-count fixtures; canonical versus block-based Markdown; title duplication; tables/code; image placeholders; clipboard failures; shortcut modifiers/input fields; unlock/change/lock cleanup; view navigation versus hydration/prefetch; concurrent atomic deltas; buffer bounds; ambiguous and definite DB failures; multiple owners; withdrawn/deleted notes; and count persistence across revisions versus separate copies.

Drive synthetic public, secret-link, invite-only, and encrypted notes, including a multi-note collection, at desktop and mobile sizes. Inspect the actual clipboard contents and network payloads/storage, not only mocked callbacks. Verify no analytics cookies, browser storage, visitor fields, referrer collection, or raw secret tokens in analytics records/logs. Normal access transport remains protected by the existing authentication design.

Capture a same-machine baseline and changed build at representative content sizes and concurrency, including a warmed run and a cold run. Use at least three repeat runs per condition. Reader p95 response time must not regress beyond the greater of five milliseconds or five percent of baseline; report browser LCP and layout-shift observations as well. Inject slow/unavailable analytics storage and verify content still loads without waiting. Averages alone do not prove the bound; store the measurements and workload with the QA evidence. These are initial acceptance limits, not promised universal production latency.

Run the hosted site's current check, typecheck, tests, affected database integration tests, and build. Perform the live Flow QA gate and inspect changed policy/help pages as running pages. Update policy wording and effective date with the feature's release. No product implementation, production data cleanup, or external communication is part of capturing this spec.

## Requirement coverage

R1-R7 are implemented directly under this no-plan spec. Completion evidence must map each requirement to its focused test or running-app scenario; there is no task breakdown to infer or recreate.
