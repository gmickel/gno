---
satisfies: [R1]
---
# fn-136-pdf-viewing-over-a-remote-link.3 PDF transport tier by size with HEAD probe

## Description
Implement R1 and prove the transport approach over the real link. Probe the asset size with a raw HEAD, then load small PDFs in one request and large PDFs with 1 MB range chunks and background fetching. This is the early proof point for the whole plan: it ends with a measured first paint over the relayed VPN link to the remote host.

**Size:** M
**Files:** `src/serve/public/lib/pdf.ts`, `src/serve/public/hooks/use-pdf-document.ts`, `test/serve/public/lib/pdf.test.ts`, `test/serve/public/hooks/use-pdf-document.dom.test.tsx`, `assets/spa-production.json.gz` (rebuilt locally for the proof measurement only; never committed by this task, task .5 commits the final snapshot)
**Touches:** [src/serve/public/lib/pdf.ts, src/serve/public/hooks/use-pdf-document.ts, test/serve/public/lib/pdf.test.ts, test/serve/public/hooks/use-pdf-document.dom.test.tsx]

### Approach
- Extend `GnoGetDocumentParams` (`src/serve/public/lib/pdf.ts:127-131`) with an optional transport hint (whole-file vs ranged) and map it in the facade (`pdf.ts:150-233`) to pdf.js options: whole-file → `disableRange: true`, `disableStream: false`, `disableAutoFetch: false`; ranged → `rangeChunkSize: 1 MB`, `disableAutoFetch: false`, `disableStream: true`. Export the size bound (8 MB) and chunk size as named constants next to the existing zoom constants (`pdf.ts:340-350`).
- In `use-pdf-document.ts` (sole caller, `:102`) issue a HEAD with a raw `fetch` before `getDocument` (the JSON helper at `src/serve/public/hooks/use-api.ts:33-110` always parses JSON and cannot be reused). Read `Content-Length`; on network failure, non-2xx, or a missing header fall back to the ranged hint. The probe runs once per document load and must respect the existing generation and stale guards; teardown semantics do not change.
- Keep every request same-origin against `/api/doc-asset` (fn-112 invariant); no new URLs.
- Tests: facade maps each hint to the expected pdf.js options; hook picks whole-file under the bound, ranged at or above it, and ranged on HEAD failure or missing header, using the existing fake `getDocument` seam from the dom test.
- Docs for the transport tier land in task .5 (`docs/WEB-UI.md` Native PDF Viewer paragraph) to keep this task's write surface disjoint from task .2.
- Proof measurement (R6 first pass): rebuild the snapshot with `bun run build:spa` for the measurement only and restore it with `git checkout -- assets/spa-production.json.gz` before committing (task .5 commits the final snapshot), run `gno serve` on the remote host behind its existing proxy, open a 50-page PDF of about 5 MB from this machine, and record from the browser network panel the request count, transferred bytes, and time to first painted page, next to the current VPN ping round trip to the remote host. Record the before numbers from a pre-change build when available. If the remote host is unreachable, record BLOCKED with the reason; the gate below applies to a failed measurement, not a missing one.

### Investigation targets
**Required** (read before coding):
- `src/serve/public/lib/pdf.ts:120-240` — facade and current transport options with their rationale comments
- `src/serve/public/hooks/use-pdf-document.ts:60-199` — load ownership, teardown, stale guards
- `test/serve/public/hooks/use-pdf-document.dom.test.tsx` — getDocument test double

**Optional** (reference as needed):
- `src/serve/routes/api.ts:2260-2306` — HEAD/Content-Length behaviour of the asset endpoint
- `notes/pdf-remote-viewing-investigation.md` — the verification plan and the numbers measured on 2026-09-02

### Key context
- With `disableStream: true` pdf.js cancels the full-body reader once ranges are advertised, so the whole-file tier must disable ranges explicitly or the first GET is thrown away.
- pdf.js range eligibility needs `Content-Length` above twice the chunk size; with a 1 MB chunk, files under 2 MB load whole anyway, which is consistent with the 8 MB bound.
- If the measured first paint is still above a few seconds with the transport change alone, stop and re-evaluate server-side rasterisation before task .4 and .5 continue; that decision is recorded in the spec's Decision context.
## Acceptance
- [ ] HEAD then a single GET for a PDF under 8 MB; no Range requests in the request log
- [ ] Ranged mode with 1 MB chunks and background fetch at or above 8 MB
- [ ] HEAD network failure, non-2xx, or missing Content-Length falls back to ranged mode without a document error
- [ ] Teardown still destroys the loading task exactly once; existing use-pdf-document tests pass
- [ ] Relay measurement recorded in the task done summary: request count, bytes, time to first painted page, and current round trip, against the pre-change numbers or an explicit note that no pre-change capture exists; or BLOCKED with the reason when the remote host is unreachable
- [ ] `bun test` and `bun run lint:check` pass
## Done summary
Implemented R1: the PDF facade takes a transport hint (`whole-file` → `disableRange`, streamed single GET; `ranged` → 1 MB chunks with background fetch) with `PDF_WHOLE_FILE_MAX_BYTES` (8 MB) and `PDF_RANGE_CHUNK_BYTES` housed in a dependency-free `pdf-transport` module and re-exported from the facade. `usePdfDocument` issues one same-origin HEAD per document load to pick the tier and falls back to ranged on network failure, non-2xx, or a missing or invalid Content-Length without a document error; a load torn down during the probe never creates a loading task; a synchronous `getDocument` throw now reaches the error state through the shared `failLoad` path. The fn-112 Playwright smoke gate was aligned with the tier: constants derived from the facade, the ranged fixture grown to 11.4 MB with page 2 spilling past the first 1 MB chunk, HEAD passed through the range controller without consuming the first-pass slot, and a new whole-file oracle asserting exactly one HEAD plus one Range-less GET on a sub-bound fixture. `bun run test:e2e:pdf` passed after the fixes.

R6 proof measurement (pre-change build, over the relayed VPN link at about 203 ms round trip, headless Chromium 1380x880 at DPR 2, largest PDF indexed on the remote host at 3.07 MB; no 5 MB / 50-page fixture exists there):
- before: first painted page 37.2 s after navigation start (cold, SPA JS uncached); doc view 79 requests and about 8.8 MB by Content-Length; 41 JS chunks / 1.24 MB; asset endpoint 26 requests = 1 full GET cancelled by pdf.js plus 25 Range requests of 64 KB, no HEAD; cold SPA root load 48 requests
- after: BLOCKED. The remote host has no shell access from this machine, so the new build could not be deployed there. Local unit and e2e coverage prove the tier selection and request pattern (HEAD then one GET under 8 MB; 1 MB ranges with background fetch at or above); the relay timing is left to task .5 once the remote install is updated.
- exposure mechanism confirmed: a same-host HTTPS reverse proxy (the reverse-proxy case in R4), not an SSH tunnel.
- gate: the measurement is blocked, not failed, so per the Early proof point it does not gate task .4.

Review: round 1 NEEDS_WORK (smoke gate invalidated, no explicit fetch double in the PdfViewer integration tests, unguarded probe continuation, inventory order, comment); all fixed through the Grok bridge in the review-fix commit. Round 2: SHIP, with one P3 (the whole-file oracle used a 1.3 KB fixture that pdf.js would never range) closed after the verdict by a conductor commit that points the oracle at a 4.2 MB range-eligible sub-bound fixture; `bun run test:e2e:pdf` re-run green (large fixture 11,384,001 B, medium fixture 4,238,157 B).

stage: wave-join - ran (cherry-pick of the worker commit and the review-fix commit onto the target; the generated SPA snapshot conflicted with task .2's refresh and was regenerated, not merged)
stage: impl-review - ran [round 1 NEEDS_WORK -> fixes -> round 2 SHIP] (model: claude-opus-5 via harness subagent, host backend; fixes: cursor-grok-4.6-high via cursor-agent bridge)
stage: plan-sync - skipped(config: planSync.enabled != true)

2026-09-06 reconciliation: restored completion state from this existing summary and merged PR #206. Gordon confirmed all remaining work was completed and requested spec closure. Earlier BLOCKED/UNMET observations above are historical and superseded by that confirmation.
## Evidence
- Commits: 98c5b6e4, 094de121, 91a69d47, 6271946dd799045e30e6e96cf0e74e8746fac4af, d17ac7d8577c87fbd14a072deef3f39db121edae
- Tests: bun test test/serve/public/hooks test/serve/public/lib test/serve/public/components/pdf/PdfViewer.dom.test.tsx test/egress/enforcement.test.ts test/serve/spa-snapshot-freshness.test.ts -> 123 pass, 0 fail (integrated target), bun run lint:check -> clean, bun run test:e2e:pdf -> PASSED (large 11,384,001 B / 200 pages ranged tier; medium 4,238,157 B / 60 pages whole-file tier: one HEAD + one Range-less GET), worker: bun test (full) -> 4436 pass, 3 fail outside Touches, all fixed by the conductor (inventory entry, PdfViewer await, snapshot rebuild)
- PRs: https://github.com/gmickel/gno/pull/206