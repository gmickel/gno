# Google Shared Drives and SharePoint library source availability

## Overview

Extend `sourceAvailability: local` to Google Drive **Shared drives** on macOS, and re-prove the OneDrive/SharePoint claim for every currently installed library root. Physical evidence on heimdall comes first; the path classifier only widens for layouts whose evidence rows pass.

## Goal & context

A GF/SapienXT user reported on 2.4.0 that `sourceAvailability: local` accepts `~/Library/CloudStorage/GoogleDrive-*/My Drive/...` but rejects `~/Library/CloudStorage/GoogleDrive-*/Shared drives/...` with `SOURCE_AVAILABILITY_UNSUPPORTED`, before any per-file availability check. That is the fn-118 design: `classifyDarwinFileProviderPath` (`src/ingestion/source-availability/darwin-path.ts`) admits only layouts covered by physical evidence, and the fn-118 Google evidence covered My Drive only. The team keeps shared company files in Shared drives and wants to index the locally materialized subset without pulling cloud-only content. `sourceAvailability: any` is not an acceptable workaround because it materializes cloud-only files.

SharePoint gap found while scoping: fn-118 proved OneDrive for "both installed immediate SharePoint library roots". heimdall now has three library roots under `OneDrive-SharedLibraries-Bregal`, and the classifier admits any immediate library root, so the third library is admitted without evidence. This spec closes that gap in the same evidence run.

Test host: **heimdall** (reachable over SSH as `heimdall`; macOS 27.0 build 26A5388g, same build as the fn-118 evidence; GNO 2.4.0 and Bun installed). It has `GoogleDrive-gordon.mickel@growthfactors.me/{My Drive,Shared drives}` with three Shared drives, and `OneDrive-SharedLibraries-Bregal` with three library roots.

## Architecture & data flow

No change to the guard itself. The fn-118 mechanism stays as is: `SF_DATALESS` classification via `lstat` `st_flags`, a process-scoped `IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES` policy that refuses materialization, `EDEADLK` translated into a cloud-placeholder skip, and dataless directory prefixes that preserve indexed descendants.

Changes:

1. `scripts/macos-file-provider-smoke-lib.ts` root validation accepts an immediate Shared drive root (`GoogleDrive-*/Shared drives/<drive>`) as a Google provider root, with the same refusals as today: the `Shared drives` aggregation root, deeper descendants, symlink roots, and arbitrary writable directories. Matrix/benchmark receipts record the Google layout (`my-drive` | `shared-drive`) so evidence rows are not conflated.
2. After evidence passes, `classifyDarwinFileProviderPath` returns `google-drive` for `GoogleDrive-*/Shared drives/<non-empty drive>/...`. The bare `Shared drives` aggregation path stays `unsupported`.
3. The OneDrive classifier is unchanged if every installed library root passes. If any library fails, narrow the claim and document the limitation. Do not broaden it on inference.

## Quick commands

```bash
bun run lint:check
bun test test/ingestion/source-availability test/scripts/macos-file-provider-smoke.test.ts
bun test
# on heimdall, from a checkout of the spec branch:
bun scripts/macos-file-provider-smoke.ts validate-root --root "<shared-drive-root>"
bun scripts/macos-file-provider-smoke.ts matrix --root "<shared-drive-root>" --fixture-id GNO-fn118-smoke-<id> --provider google
bun scripts/macos-file-provider-smoke.ts matrix --root "<sharepoint-library-root>" --fixture-id GNO-fn118-smoke-<id> --provider onedrive
```

## Boundaries / non-goals

- macOS File Provider only. No Windows Cloud Files, Linux/FUSE, or Drive API integration.
- No inference across layouts or libraries: Shared drive support does not follow from My Drive, a library from another library, or one Shared drive from another beyond what the evidence rows state.
- My Drive shortcuts that point into Shared drives are out of scope. Do not recommend them as a workaround.
- Evidence runs use dedicated disposable `GNO-fn118-smoke-*` fixtures only. They do not read existing file contents, and receipts keep hashing roots, fixture IDs, drive names, and library names.
- **Human approval gate:** creating fixtures in a Shared drive or SharePoint library writes to a live shared tenant that other members can see. Gordon approves the chosen target drive/library and the fixture create/cleanup plan before any mutating harness command runs on heimdall. Read-only `validate-root`/`probe` need no extra approval.
- The guarantee still concerns GNO-triggered content materialization only. Provider metadata bookkeeping may still occur.

## Strategy Alignment

- **Local knowledge lifecycle**: makes shared company drives safe to index locally.
- **Controlled portability**: keeps cloud content movement explicit.

## Decision context

- Keep fn-118's evidence-first, fail-closed rule. The reported rejection is correct behavior until Shared drives are proven.
- Use heimdall because it has the real Shared drives and SharePoint libraries plus the same OS build as the fn-118 evidence.
- Fold the SharePoint re-proof into this spec because the gap was found while scoping and runs on the same host with the same harness.
- If a matrix row returns FAIL for Shared drives (for example, a guarded read materializes content or `SF_DATALESS` is not reported), stop. Do not widen the classifier. Record the finding and update docs to state the limitation.

## Acceptance Criteria

- **R1:** The smoke harness accepts an immediate Google Shared drive root as a provider root and refuses the `Shared drives` aggregation root, deeper descendants, and symlink roots. Receipts distinguish `my-drive` and `shared-drive` layouts. Unit tests cover the accept/refuse cases. Errors/boundaries: unknown layouts fail closed with a non-zero exit.
- **R2:** On heimdall, a full fn-118 matrix (local, pinned-offline, cached-unpinned, cloud-only, nested-dataless-directory, partial-content where reproducible, classification-to-read race) runs against at least one Shared drive with approved write access. Every row is PASS, FAIL, BLOCKED, or NOT AVAILABLE with evidence. The cloud-only guarded read refuses without changing independently observed availability. Receipts land under `research/file-provider/evidence/` with environment (OS, hardware, Bun/GNO/Drive versions) and redacted identities. Errors/boundaries: a drive without write access is BLOCKED, never inferred.
- **R3:** On heimdall, the OneDrive matrix runs against **every** installed library root under the SharedLibraries domain (currently three). The recorded evidence and docs name the proven count. Errors/boundaries: a failing or blocked library narrows the documented claim, and if needed the classifier, rather than inheriting another library's result.
- **R4:** Only if R2's cloud-only, nested-dataless, and race rows PASS, `classifyDarwinFileProviderPath` returns `google-drive` for `GoogleDrive-*/Shared drives/<drive>/...`, and the aggregation path stays `unsupported`. `test/ingestion/source-availability/darwin-path.test.ts` covers Shared drive root, descendant, aggregation root, and empty-name cases. Errors/boundaries: My Drive behavior is unchanged.
- **R5:** An end-to-end check on heimdall indexes a collection rooted in the tested Shared drive with `sourceAvailability: local` using the branch build. Materialized files are indexed, cloud-only fixtures produce `CLOUD_PLACEHOLDER` skips, and the observed availability of the cloud-only fixtures is unchanged afterwards. Evidence consists of captured CLI/JSON output.
- **R6:** Docs match the evidence: `docs/CONFIGURATION.md` evidence scope and example, `docs/TROUBLESHOOTING.md` `SOURCE_AVAILABILITY_UNSUPPORTED` row, `spec/cli.md` if wording changes, the CHANGELOG `[Unreleased]` entry crediting the reporter, and the gno.sh source-availability docs. No claim goes beyond the recorded rows.
- **R7:** The fixtures created on Shared drives and SharePoint libraries are removed through the harness `cleanup-plan` after evidence capture, with Gordon's approval. Cleanup is confirmed and recorded in the evidence receipt.

## References

- fn-118-cloud-placeholder-safe-indexing (spec, harness, evidence `research/file-provider/evidence/2026-08-16-*.json`)
- `src/ingestion/source-availability/darwin-path.ts`, `scripts/macos-file-provider-smoke-lib.ts`
- Apple TN3150, Getting ready for data-less files

## Resolution (2026-09-26)

Evidence: `research/file-provider/2026-09-26-shared-drives-and-sharepoint.md` and `research/file-provider/evidence/2026-09-26-shared-drives-and-sharepoint.json`.

- **R1:** the harness accepts immediate Shared drive roots and refuses the aggregation root, descendants, symlinked roots, and symlinked `Shared drives`/domain directories. Receipts carry `layout`. Unit tests are in `test/scripts/macos-file-provider-smoke.test.ts`.
- **R2:** on the Shared drive, local and cached-unpinned PASS, pinned-offline BLOCKED, partial-content NOT AVAILABLE. Google Drive 131.0 would not evict the fixtures on request, so:
  - cloud-only was observed on real never-downloaded Shared drive items (`EDEADLK`, 0 bytes, still dataless);
  - the race row is **inferred, not observed**, from the same Google provider domain and process-scope I/O policy that passed the My Drive race (fn-118) and both SharePoint races;
  - nested-dataless-directory is NOT AVAILABLE, the same as My Drive.
- **R3:** **two** library roots are installed, not three. They are the same two roots fn-118 tested, and both are re-proven here (cloud-only and race PASS in each). The docs say two.
- **R4:** the maintainer accepted the gate on the evidence above (inferred race, nested-dataless NOT AVAILABLE). The classifier admits `GoogleDrive-*/Shared drives/<drive>/...`; the aggregation path stays unsupported.
- **R5:** the branch build under `local` indexed 25 own local files and skipped 3 never-downloaded files as `CLOUD_PLACEHOLDER`; those 3 stayed dataless.
- **R6:** docs, README, GLOSSARY, `spec/cli.md`, CHANGELOG, and gno.sh are updated.
- **R7:** all four fixtures were moved to Trash after `cleanup-plan`; their absence was verified.
