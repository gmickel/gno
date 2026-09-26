# macOS File Provider follow-up: Google Shared drives and SharePoint libraries (2026-09-26)

**Outcome:** `sourceAvailability: local` now admits immediate Google Drive
Shared drive roots (`GoogleDrive-*/Shared drives/<drive>/...`). The bare
`Shared drives` folder stays unsupported. The OneDrive claim is re-proven for
the **two** SharePoint library roots installed on the test host. Both are the
same two roots proven on 2026-08-16.

Evidence: [`evidence/2026-09-26-shared-drives-and-sharepoint.json`](evidence/2026-09-26-shared-drives-and-sharepoint.json).
Drive, library, fixture, and file names appear only as SHA-256 tokens.

## Environment

- Host: Apple M4 Max, arm64, macOS 27.0 (26A5388g). This is the same OS build
  as the 2026-08-16 evidence.
- Google Drive for desktop 131.0, with three Shared drives installed.
- OneDrive 26.163.0823, with one SharedLibraries domain holding two immediate
  library roots.
- Bun 1.4.2. GNO 2.7.1, branch build.
- Harness: `scripts/macos-file-provider-smoke.ts`, which now accepts an
  immediate Shared drive root and records the layout (`my-drive`,
  `shared-drive`, `icloud-drive`, `sharepoint-library`) in every receipt.

## Root validation

`validate-root` accepted all three Shared drives (`google` / `shared-drive`)
and both library roots (`onedrive` / `sharepoint-library`), plus My Drive as a
control (`my-drive`). It refused four shapes with exit code 1:

- the `Shared drives` folder itself
- a path deeper inside a drive
- the Google account root
- the SharedLibraries domain root

## Matrix results

| State                       | Google Shared drive                                               | SharePoint library 1                                                                | SharePoint library 2    |
| --------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------- |
| Local                       | **PASS**                                                          | **PASS**                                                                            | **PASS**                |
| Pinned/offline              | **BLOCKED**: offline state not safely induced                     | **BLOCKED**                                                                         | **BLOCKED**             |
| Cached, unpinned            | **PASS**                                                          | **PASS**                                                                            | **PASS**                |
| Cloud-only                  | **PASS**, observed on existing never-downloaded items (see below) | **PASS**: `SF_DATALESS` before/after, `EDEADLK`/errno 11/0 bytes                    | **PASS**, same result   |
| Nested dataless directory   | **NOT AVAILABLE**: folders never report `SF_DATALESS`             | **NOT AVAILABLE**, same                                                             | **NOT AVAILABLE**, same |
| Partial content             | **NOT AVAILABLE**: no safe partial-range control                  | **NOT AVAILABLE**                                                                   | **NOT AVAILABLE**       |
| Classification-to-read race | **INFERRED, not observed** (see below)                            | **PASS**. A first 60 s window did not transition (NOT AVAILABLE); a second one did. | **PASS** (60 s window)  |

Eviction for the SharePoint fixtures used Finder's "Free Up Space".

## Google Shared drive: why cloud-only and race use other evidence

Google Drive for desktop 131.0 did not evict the dedicated fixtures on
request. We tried "Make online-only" on a file and online-only on the fixture
folder. In both cases the content stayed materialized (`isDownloaded=1`, no
`SF_DATALESS`) for more than 20 minutes and across a Drive restart. macOS
offers no command-line eviction for this provider: `fileproviderctl` has no
evict verb, and `brctl` handles only iCloud. So the cloud-only and race rows
could not be produced on our own fixtures.

**Cloud-only: observed on real items.** Google reports Shared drive items
that were never downloaded as `SF_DATALESS`. In a metadata sample, 292 of 300
files were dataless in one drive, 4 of 171 in another, and 3 of 6 in the
third. On three never-downloaded files, the harness ran a metadata probe and a
guarded no-materialize read. Each returned `EDEADLK` (errno 11) with 0 bytes,
and each file was still dataless afterwards. No content was printed, and file
names are recorded only as hashes.

**Race: inferred, not observed.** No Shared drive fixture could be moved from
local to dataless, so there was no window in which to test a race. The
admission instead rests on three facts:

- A Shared drive is in the same Google provider domain as My Drive.
- The same process-scope `IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES` policy
  applies.
- That policy passed the My Drive race on 2026-08-16 and both SharePoint
  races here.

The policy acts at read time, whatever the state was at classification time.
This row is inferred, and the claim says so.

**Nested dataless directory:** NOT AVAILABLE is accepted here, as it was for
My Drive on 2026-08-16. Folders do not acquire `SF_DATALESS` on this provider.

## End-to-end indexing

The branch build ran with `sourceAvailability: local` in an isolated GNO root:

- **Own fixture** (25 local files) in a Shared drive: 25 indexed, 0 skipped,
  and all 25 were still local afterwards.
- **Existing folder** in another Shared drive, with 3 never-downloaded files
  and no subfolders: 0 indexed, 3 skipped as `CLOUD_PLACEHOLDER`, and all 3
  were still dataless afterwards. The run took 1 s.

## Session note

Two earlier end-to-end attempts ran against a whole Shared drive for 10 to 14
minutes before they were stopped. The config edit had not applied, so they ran
with the default `any` policy. As `any` is designed to do, they read files and
pulled roughly 12 of 300 sampled files into the local Google Drive cache on
the test host. Nothing on the drive was modified or deleted, and the
throwaway indexes were deleted. This was not a local-mode failure.

## Cleanup

`cleanup-plan` validated each fixture. All four fixtures (two in a Shared
drive, one per SharePoint library) were then moved to Trash with a
`GNO-fn118-smoke-fn179-*` name guard. Directory listings confirm none remain.

## Commands

```bash
bun scripts/macos-file-provider-smoke.ts validate-root --root "<root>"
bun scripts/macos-file-provider-smoke.ts create-fixture --root "<root>" --fixture-id GNO-fn118-smoke-<id> [--dry-run]
bun scripts/macos-file-provider-smoke.ts matrix --root "<root>" --fixture-id GNO-fn118-smoke-<id> --provider <google|onedrive> --row <state> [--race-delay-ms 60000]
bun scripts/macos-file-provider-smoke.ts cleanup-plan --root "<root>" --fixture-id GNO-fn118-smoke-<id>
```
