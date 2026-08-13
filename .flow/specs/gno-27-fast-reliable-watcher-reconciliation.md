# Fast, reliable watcher reconciliation

## Conversation Evidence

> user (turn 1, part 1): "great, now check:"
> user (turn 1, part 2): "[gmickel/gno#183](https://github.com/gmickel/gno/pull/183)"
> user (turn 1, part 3): "what can we do with this? it's older so probably some drift from the things we'lve landed"
> user (turn 1, part 4): "good PR, good fix? any unintended consequences? can it be brought forward"
> user (turn 2): "so do you think worth it though or will this lead to perf probloems for all"
> user (turn 3): "ok, plan this work, we need to get the perf thing fixed first, and you would create your own PR you said, right, get started"
> user (turn 4, part 1): "i just reinstalled flow-next, we should have an even newer version, check and run [$flow-next-setup](/Users/gordon/.codex/skills/flow-next-setup/SKILL.md)"
> user (turn 4, part 2): "but after that is done, i do not want a spec for this work yet, i want to do all the testing we need to be able to write the spec later"
> user (turn 5): "ok, 1"
> user (turn 6): "can you do the probe thing now as the last evidence we need before capturing the spec"
> user (turn 7): "[$flow-next-capture](/Users/gordon/.codex/skills/flow-next-capture/SKILL.md) we have all the evidence to implement this quickly and efficiently"

## Goal & Context
<!-- scope: business -->
<!-- Source-tag breakdown: 35% [user] / 55% [paraphrase] / 10% [strategy:Local knowledge lifecycle] -->

Continuous indexing can silently miss atomic saves when the filesystem watcher
reports only an ineligible temporary filename. Partial recursive-delete events
can likewise leave deleted documents retrievable until a manual update. PR #183
demonstrated the correctness problem and a viable reconciliation direction, but
its branch has drifted and its ambiguous-event path can submit every unchanged
sibling to the expensive synchronization pipeline.

The measured current-main cost is about 15 seconds for 5,000 unchanged files.
The validated direction preserves content-safe hashing while reducing candidate
discovery to milliseconds on macOS/Linux and under 500 ms on Windows. The goal
is a fresh maintainer implementation that brings forward the contributor's core
fix without importing the stale branch or imposing that full-directory cost on
normal watcher activity.

## Architecture & Data Models
<!-- scope: technical -->
<!-- Source-tag breakdown: 10% [user] / 90% [paraphrase] -->

The watcher owns an in-memory, per-collection hierarchical snapshot indexed by
directory. Each no-follow entry fingerprint contains file kind, device, inode,
size, nanosecond modification time, and nanosecond change time. Fingerprints
select candidates only; they never prove that indexed content is unchanged.

Exact eligible watcher paths retain the existing targeted synchronization path
and therefore the existing full content-hash decision. Ineligible, missing, or
otherwise ambiguous events mark a directory dirty. A flush compares that
directory's direct children with the prior snapshot, recurses only into changed
or new directories, and expands removed directories from the prior snapshot.
When a reported path vanished, reconciliation climbs to the nearest surviving
ancestor before diffing so incompletely reported subtree deletions cannot miss
siblings.

Candidates from exact events and snapshot reconciliation are deduplicated into
one targeted synchronization batch. The snapshot advances only after successful
classification. Initialization races, snapshot limits, unreliable metadata, or
scan failures use a bounded disk/index reconciliation fallback based on active
direct children and descendants; failure never implies deletion.

## API Contracts
<!-- scope: technical -->
<!-- Source-tag breakdown: 100% [paraphrase] -->

The public CLI, REST, status, and output schemas remain unchanged. `gno serve`
and `gno daemon` gain reliable continuous-index behavior through their shared
resident watcher.

The internal event contract distinguishes two paths:

- an exact eligible source path must reach content-safe targeted synchronization;
- an ambiguous event is only a hint about an affected directory and must be
  classified before candidate paths reach synchronization.

The fallback store contract returns active indexed source paths for bounded
direct-child and descendant queries. Store errors are explicit failures; an
empty answer is actionable only after a successful query.

## Edge Cases & Constraints
<!-- scope: technical -->

- Filesystem event filenames and shapes vary by operating system and Bun patch release; correctness cannot depend on temp-name heuristics. [paraphrase]
- Windows may preserve every tested fingerprint field for an in-place same-size edit with restored modification time; exact eligible paths must therefore always be content-hashed. [paraphrase]
- Atomic replacement with preserved size and modification time must still be discoverable through inode/change metadata and then content-hashed. [paraphrase]
- Snapshot scans must not follow symlinks outside the collection, while replacing a symlink itself with an eligible file remains discoverable. [paraphrase]
- Watcher startup begins event capture before snapshot construction; events observed during initialization are buffered and force a correctness-preserving reconciliation rather than being absorbed into the baseline. [paraphrase]
- Application-write suppression, collection-rule changes, root replacement, queued edits during synchronization, ABA remove/re-add, and disposal remain hard lifecycle boundaries. [paraphrase]
- Record-container sources use the same eligibility rules and preserve their multi-document inactivation semantics. [paraphrase]
- Snapshot entries, dirty-directory queues, suppression history, and debounce windows are bounded; sustained churn has a finite maximum flush delay. [paraphrase]
- The implementation defines one documented service-wide snapshot ceiling and falls back without losing updates when that ceiling is exceeded. [paraphrase]
- Watcher filenames are treated as untrusted relative hints: absolute paths, traversal, NUL-like invalid values, and paths outside the collection are rejected before any scan or suppression lookup.
- Excluded subtrees remain ignored, while collection-rule or root-generation changes invalidate the prior snapshot and retain the existing exact full-reconciliation boundary.
- A missing or unreadable collection root, permission error, failed directory scan, failed store query, or partial synchronization result never implies deletion. The affected directory stays dirty and is retried after bounded backoff or the next event/config refresh.
- Active record-container descendants are reconciled by their source-container path so one removed container inactivates all derived logical documents.
- Snapshot initialization captures watcher events before constructing the baseline; buffered events and events arriving during classification/synchronization are replayed against a newer generation rather than absorbed into stale state.
- Snapshot and pending-hint state use fixed service-wide ceilings, and the resettable debounce has a finite hard maximum flush delay. Overflow degrades to bounded disk/index reconciliation instead of dropping work.

## Quick commands

```bash
bun test test/serve/watch-snapshot.test.ts test/store/watcher-source-paths.test.ts
bun test test/serve/watch-service.test.ts test/serve/watch-service-filesystem.test.ts
bun run lint:check && bun test
.flow/bin/flowctl validate --spec gno-27-fast-reliable-watcher-reconciliation --json
```

## Acceptance Criteria
<!-- scope: both -->

- **R1:** On real local filesystems, plain-temp and dot-temp atomic replacements become searchable through the running resident service without a manual update on macOS, Linux Bun 1.3.11/latest, and Windows Bun 1.3.11/latest. Errors: unsupported or unreadable filesystem metadata activates the correctness-preserving fallback and is not claimed as fast-path proof.
- **R2:** Recursive deletion removes every indexed descendant at multiple depths, post-watch directory creation indexes its eligible children when the platform emits an event, record-container deletions inactivate every derived logical document, and untouched siblings remain searchable. Errors: missing roots, permission failures, and incomplete directory events retain active state until a successful reconciliation proves removal.
- **R3:** An exact eligible event always reaches content hashing, including same-size/restored-mtime in-place edits whose filesystem fingerprint is unchanged; fingerprints are used only to discover unnamed candidates. Errors: invalid, absolute, escaping, or excluded watcher paths cannot cause an outside-root scan or suppression bypass.
- **R4:** For one changed file among 5,000 eligible siblings, ambiguous-event candidate discovery submits only the changed path and meets p95 budgets of 250 ms on macOS/Linux and 500 ms on Windows across a documented warm-up/run protocol. Errors: ceiling overflow or unreliable metadata may take the bounded fallback and is reported separately from the fast-path measurement.
- **R5:** Snapshot initialization, forced ceiling overflow, scan failure, store failure, partial synchronization failure, unreliable metadata, and root loss are covered by tests proving no update or deletion is silently lost and no failed query infers inactivation. Errors: failed classification or synchronization keeps the affected directory dirty for bounded retry and advances no unproven snapshot state.
- **R6:** Suppression, collection-rule and root-generation changes, events during initialization or in-flight synchronization, ABA remove/re-add, disposal, and sustained unique-temp churn preserve existing lifecycle guarantees; pending hints and snapshots have documented fixed ceilings, and churn flushes within a documented finite hard maximum delay. Errors: overflow degrades to bounded reconciliation and shutdown discards uncommitted snapshot generations without post-disposal callbacks.
- **R7:** A live `gno serve` proof with a real store demonstrates atomic-save searchability, multi-depth deletion, untouched-sibling preservation, and API responsiveness without a manual update; the same watcher contract remains shared by daemon mode. Errors: the proof uses bounded polling and deterministic local embedding/search fixtures, fails on timeout, and makes no blanket network/removable-filesystem guarantee.

## Boundaries
<!-- scope: business -->

- Build a fresh maintainer PR and credit @DanielKillenberger; do not merge PR #183 as-is or import its unrelated branch history. [user]
- Do not add a global `mtime + size` ingestion shortcut or otherwise weaken content hashing for exact candidates. [paraphrase]
- Do not persist watcher fingerprints in the database in this first implementation; the selected normal path is watcher-owned memory with a bounded store fallback. [paraphrase]
- Do not add filename heuristics that assume one editor, temporary-file convention, operating system, or Bun patch behavior. [paraphrase]
- Do not claim reliable network/removable/coarse-timestamp filesystem behavior unless the correctness-preserving fallback is active and verified. [paraphrase]
- Do not broaden this work into unrelated synchronization, retrieval, or UI performance refactors. [paraphrase]

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

- Correctness is worth bringing forward only if ambiguous events do not impose the measured multi-second unchanged-file cost on every sibling. [paraphrase]
- Performance risk is addressed before importing the watcher fix because the new reconciliation path makes the pre-existing cost reachable during normal service operation. [paraphrase]
- A fresh PR keeps contributor credit and the validated core idea while avoiding drift and unrelated scope from PR #183. [paraphrase]

### Implementation Tradeoffs
<!-- scope: technical -->

- A watcher-owned snapshot avoids a schema migration and makes unchanged-sibling selection cheap, at the cost of bounded memory and startup construction. [paraphrase]
- Persistent `mtime + size` shortcuts were rejected because preserved metadata can silently stale the index; Windows evidence also proves change time is not a universal unchanged-content proof. [paraphrase]
- Exact events remain conservative and hash content; only ambiguous-event candidate discovery uses fingerprints. [paraphrase]
- The bounded store reconciliation seam remains as a slower fail-safe for initialization races, limits, and metadata uncertainty rather than the normal path. [paraphrase]

## Strategy Alignment

- **Local knowledge lifecycle** — reliable, automatic source-change recovery prevents the resident index from silently diverging from local files.
- **Coherent agent and application surfaces** — serve and daemon retain one watcher/synchronization contract and one index truth.

## Strategy Conflicts

- No conflict detected with the local-first evidence-layer approach or any active strategy track.

## Implementation Plan

1. `gno-27-fast-reliable-watcher-reconciliation.1` — Add bounded watcher snapshot and active-source fallback primitives (**M**).
2. `gno-27-fast-reliable-watcher-reconciliation.2` — Integrate exact and ambiguous watcher reconciliation (**M**); depends on task 1.
3. `gno-27-fast-reliable-watcher-reconciliation.3` — Prove lifecycle, cross-platform correctness, and candidate-selection performance (**M**); depends on task 2.
4. `gno-27-fast-reliable-watcher-reconciliation.4` — Reconcile documentation, hosted-site truth, changelog credit, and final gates (**M**); depends on task 3.

## Early proof point

Task `gno-27-fast-reliable-watcher-reconciliation.1` validates the core approach by proving that a bounded no-follow snapshot selects only changed/new/removed candidates and that the store fallback returns the same active source-path set without inferring deletion on failure.
If it fails, re-evaluate the watcher-owned hierarchical snapshot boundary before continuing with task 2+.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
| --- | --- | --- | --- |
| R1 | Cross-platform atomic replacement recovery | gno-27-fast-reliable-watcher-reconciliation.2, .3 | — |
| R2 | Recursive delete/new-directory/record-container correctness | gno-27-fast-reliable-watcher-reconciliation.1, .2, .3 | — |
| R3 | Exact events preserve content hashing and path containment | gno-27-fast-reliable-watcher-reconciliation.2, .3 | — |
| R4 | One-of-5,000 candidate selection and p95 budgets | gno-27-fast-reliable-watcher-reconciliation.1, .3 | — |
| R5 | Initialization, overflow, scan/store/sync failure safety | gno-27-fast-reliable-watcher-reconciliation.1, .2, .3 | — |
| R6 | Lifecycle races, bounded state, finite churn delay | gno-27-fast-reliable-watcher-reconciliation.2, .3 | — |
| R7 | Live serve proof and shared daemon contract | gno-27-fast-reliable-watcher-reconciliation.3, .4 | — |
