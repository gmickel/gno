# macOS File Provider no-materialization smoke — 2026-08-16

## Verdict

**Do not begin the production implementation from this candidate unchanged.** The provider-neutral macOS mechanism is semantically feasible for the independently tested Google Drive and iCloud Drive cloud-only files: `SF_DATALESS` classification plus process-scoped no-materialization I/O policy refused content with `EDEADLK`, read zero bytes, and left the file dataless. OneDrive support remains unclaimed.

The measured naive candidate—an extra `lstat` availability check for every discovered file—cost **15.2323% median** on the representative 5,000-file all-local corpus (71.8915 ms baseline; 82.8422 ms candidate). This exceeds R6's proposed 10% local-mode budget. Re-evaluate the integration before task `.2`: the promising hypothesis is to reuse flags from the traversal's existing stat and perform the guarded recheck only when a file is consumed or changed. That hypothesis was **not measured here and is not a pass**.

No production ingestion behavior changed.

## Environment and scope

- macOS 27.0 beta, build 26A5388g; Apple M4 Max, arm64.
- Bun 1.3.14; GNO 1.34.6.
- Google Drive 129.0+129.0.1; iCloud provider supplied by the tested OS; OneDrive 26.139.0720+26139.0720.0007.
- Exact installed provider roots were validated structurally before mutation, then represented only by SHA-256 tokens in tracked evidence.
- Each provider received one newly created, exclusive `GNO-fn118-smoke-*` fixture containing 25 deterministic Markdown files. Existing user-file contents and names were not read or retained.
- Availability changes were requested only for those dedicated files/directories. After capture, all three exact fixture directories were moved to Trash and verified absent at their original paths.
- Beta OS status is a material caveat. These results do not establish behavior on a stable macOS release or a different provider version.

## Apple contract used

Apple's [TN3150: Getting ready for data-less files](https://developer.apple.com/documentation/technotes/tn3150-getting-ready-for-data-less-files) defines `SF_DATALESS`, explains that `stat`/`getattrlist` can themselves materialize intermediate dataless directories, and documents `setiopolicy_np` with materialization disabled so a content read is refused rather than hydrated. The harness therefore:

1. observes `st_flags` with Darwin `lstat`;
2. establishes the no-materialization policy at process scope before asynchronous Bun reads;
3. treats `EDEADLK` as a cloud-placeholder refusal only at that guarded boundary;
4. always restores the prior policy and fails closed if setup or restoration fails; and
5. records state before and after every physical probe.

The study also consulted Apple's [File Provider synchronization guidance](https://developer.apple.com/documentation/fileprovider/synchronizing-the-file-provider-extension), [eviction API](https://developer.apple.com/documentation/fileprovider/nsfileprovidermanager/evictitem%28identifier%3Acompletionhandler%3A%29?changes=_2_8), and [materialization flags](https://developer.apple.com/documentation/fileprovider/nsfileprovidermaterializationflags). Provider UI actions were used because the fixture is outside an extension controlled by GNO; no provider-private API was added.

## Provider/state matrix

Each cell is independent. `NOT AVAILABLE` is not evidence for or against another provider.

| State                       | Google Drive                                                                                                                                         | iCloud Drive                                                                                                                   | OneDrive                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Local                       | **PASS** — metadata/traversal preserved non-dataless state; guarded read succeeded, 43 bytes                                                         | **PASS** — same independently                                                                                                  | **PASS, local filesystem only** — same probe; no cloud support claim |
| Pinned/offline              | **BLOCKED** — pin action existed; provider-offline state not safely induced                                                                          | **BLOCKED** — same independently                                                                                               | **NOT AVAILABLE** — fixture excluded from sync; no pin action        |
| Cached, unpinned            | **PASS** — downloaded, not keep-downloaded; probes preserved local state                                                                             | **PASS** — same independently                                                                                                  | **NOT AVAILABLE** — fixture excluded from sync                       |
| Cloud-only                  | **PASS** — metadata, traversal, and guarded read preserved `SF_DATALESS`; read returned `EDEADLK`/errno 11/0 bytes                                   | **PASS** — same independently                                                                                                  | **NOT AVAILABLE** — fixture excluded from sync; no eviction action   |
| Nested dataless directory   | **NOT AVAILABLE** — Finder offered eviction, but the dedicated directory never acquired `SF_DATALESS`                                                | **NOT AVAILABLE** — same independently                                                                                         | **NOT AVAILABLE**                                                    |
| Partial content             | **NOT AVAILABLE** — no reproducible partial-range control for the tiny fixture                                                                       | **NOT AVAILABLE** — same independently                                                                                         | **NOT AVAILABLE**                                                    |
| Classification-to-read race | **PASS** — materialized initially; eviction during a 20 s window produced `SF_DATALESS`; guarded read returned `EDEADLK`/0 bytes and preserved state | **NOT AVAILABLE** — controlled 15 s attempt did not transition; guarded read legitimately read the still-local 35-byte fixture | **NOT AVAILABLE**                                                    |

OneDrive detail: the installed root available for safe testing was the SharedLibraries aggregation root. Finder marked the dedicated top-level fixture excluded from sync and exposed neither eviction nor pin controls. Its all-local row is useful only as filesystem latency/correctness evidence. It does not verify OneDrive File Provider cloud states.

## Probe results and interpretation

For both Google Drive and iCloud Drive cloud-only targets, all three probes observed `SF_DATALESS` before and after:

- Metadata: classification only; no state transition.
- Traversal: fixture-root enumeration did not hydrate the exact dataless target. This does not erase TN3150's intermediate-directory caveat.
- Guarded read: failed with `EDEADLK` (errno 11), zero bytes, and no state transition.

The Google race is the strongest proof of the required second check at the content boundary. A file changed from materialized at classification time to dataless before read; the active I/O policy still prevented hydration. iCloud's unsuccessful race setup is retained as `NOT AVAILABLE`, not inferred from Google.

## Performance

The decision-grade corpus was an owned temporary local directory with 5,000 flat deterministic Markdown files, matching the scale of the existing watcher benchmark. Every measured lane used two warmups and nine retained samples; results include raw samples, median, p95, min, max, and standard deviation.

| Lane                                           |     Median |         p95 | Notes                                                                           |
| ---------------------------------------------- | ---------: | ----------: | ------------------------------------------------------------------------------- |
| Current walker-like discovery/traversal + stat | 71.8915 ms |  73.4625 ms | Baseline                                                                        |
| Availability metadata only                     | 10.9837 ms |  12.3504 ms | One failed observer attempt discarded and replaced; nine clean samples retained |
| Naive discovery + extra availability check     | 82.8422 ms |  84.6746 ms | **+15.2323%; FAIL against 10% target**                                          |
| Guarded read/hash                              | 84.4394 ms | 129.1571 ms | Separate phase; one high tail retained, not silently discarded                  |
| Conversion                                     |        N/A |         N/A | Markdown fixture needs no conversion                                            |
| Embedding                                      |        N/A |         N/A | Pre-implementation smoke did not invoke production models                       |

The 25-file provider fixture measurements also followed 2+9 and are retained as provider-specific latency evidence. Their relative overheads (Google 52.6724%, iCloud 27.7977%, OneDrive-local 22.7222%) are dominated by sub-millisecond fixed costs and are too noisy to decide R6. The 5,000-file controlled corpus is the decision basis.

## Explicit boundaries

- Unsupported filesystem/root: **PASS** — exact-root validation refuses arbitrary and nonexistent roots before mutation.
- Unavailable provider: **PASS** — missing installed-provider roots are rejected without mutation.
- I/O-policy setup and restore failures: **PASS** — injected focused checks fail closed without a content read or false safety claim.
- Permission denial: **BLOCKED** — not physically induced; a non-`EDEADLK` open/read error remains an error, not a cloud skip.
- Provider offline: **BLOCKED** — network/provider state was not changed on the user's host.
- Timeout: **BLOCKED** — no safe deterministic provider-timeout control was available.
- Unknown flags: **PASS** — deterministic parser rejection and nonzero exit.
- Race-time refusal: **PASS for Google only**; other providers retain their own row verdict.
- Observer uncertainty: unknown state or observer/policy failure is fail-closed. No ambiguous result claims no-materialization safety.

## Reproduction

```bash
bun scripts/macos-file-provider-smoke.ts --help
bun scripts/macos-file-provider-smoke.ts validate-root --root <installed-provider-root>
bun scripts/macos-file-provider-smoke.ts create-fixture --root <installed-provider-root> --fixture-id GNO-fn118-smoke-<unique> --dry-run
bun scripts/macos-file-provider-smoke.ts create-fixture --root <installed-provider-root> --fixture-id GNO-fn118-smoke-<unique>
bun scripts/macos-file-provider-smoke.ts matrix --root <installed-provider-root> --fixture-id GNO-fn118-smoke-<unique> --provider <google|icloud|onedrive> --row <state>
bun scripts/macos-file-provider-smoke.ts benchmark --root <installed-provider-root> --fixture-id GNO-fn118-smoke-<unique> --provider <label> --provider-version <version>
bun scripts/macos-file-provider-smoke.ts benchmark-local --corpus-files 5000
bun scripts/macos-file-provider-smoke.ts cleanup-plan --root <installed-provider-root> --fixture-id GNO-fn118-smoke-<unique>
```

The harness never deletes. `cleanup-plan` validates the exact child and emits a redacted Trash plan; the host moves only that child to Trash.

## Tracked evidence

- `research/file-provider/evidence/2026-08-16-environment.json` — SHA-256 `ceb46475bd4e3f31fe71d7f2d35e4a7dafd8a158239d3d6982720947786ebfdb`
- `research/file-provider/evidence/2026-08-16-provider-matrix.json` — SHA-256 `19d40150e164c8ca91f2252884f2b59e78d4fbe665b2d1e939bcc0978a24fbf0`
- `research/file-provider/evidence/2026-08-16-performance.json` — SHA-256 `0807dc8fe26003ac7b12a529183966cd50b6c26f49d3071337a35c282a0d7835`

The evidence contains provider labels and versions, hashes of roots/fixture IDs, numeric state, and timings. It contains no credentials, full provider paths, existing user-file names, or source bytes.
