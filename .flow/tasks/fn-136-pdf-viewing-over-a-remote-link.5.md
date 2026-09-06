---
satisfies: [R6, R7]
---
# fn-136-pdf-viewing-over-a-remote-link.5 Remote-link verification, docs, CHANGELOG, and gno.sh

## Description
Close the spec. Measure R6 and R7 over the real relayed VPN link to the remote host with all four implementation tasks landed, measure the warm-reload JavaScript transfer for R3, refresh the SPA snapshot, and finish the documentation set including the hosted site. Depends on tasks .1 to .4.

**Size:** M
**Files:** `assets/spa-production.json.gz` (via `bun run build:spa`), `CHANGELOG.md`, `docs/API.md`, `docs/WEB-UI.md`, `src/serve/CLAUDE.md`, and the REST API, web UI, and remote-access pages in the external repo `~/work/gno.sh`
**Touches:** [assets/spa-production.json.gz, CHANGELOG.md, docs/API.md, docs/WEB-UI.md, src/serve/CLAUDE.md]

External repository note: `~/work/gno.sh` is a separate git repository, so its pages cannot be declared in Touches or locked by the wave dispatcher. This task runs alone in its wave and edits, drives, and commits the site pages serially after the in-repo changes.

### Approach
- Run `bun run build:spa` so the committed snapshot carries the client changes from .3 and .4.
- Cold measurement (R6): start `gno serve` on the remote host behind its existing proxy, open a 50-page PDF of about 5 MB from this machine with an empty cache, and capture the browser network panel: request count, transferred bytes, time to first painted page, and the current VPN ping round trip to the remote host. Compare with the task .3 numbers. If the remote host is unreachable, record BLOCKED, never PASS.
- Warm measurement (R3): reload the same document page with the cache intact and record transferred JavaScript bytes and the cache state of the hashed chunks; the target is under 100 KB.
- Sharpness (R7): capture a screenshot from the remote browser with its reported device pixel ratio and viewport. If the page is sharp, R7 is met. If it is still blurry, attach the capture (DPR, viewport, browser, page count) to the spec, add a follow-up task to this spec, and leave R7 unmet in the requirement coverage table; the spec must not be closed while R7 is unmet.
- CHANGELOG `[Unreleased]`: Changed entries for doc-asset caching, SPA compression, PDF transport and first paint; Added entry for `localClient`, the reveal 403, and the locality-aware actions.
- Add the transport paragraph to `docs/WEB-UI.md` Native PDF Viewer (line about 256-295): small PDFs load whole after a HEAD size probe, large PDFs use 1 MB range chunks with background fetching, and page 1 paints before all page geometry resolves. Then reconcile `docs/API.md`, `docs/WEB-UI.md`, and `src/serve/CLAUDE.md` for any wording the implementation tasks left inconsistent, then mirror the REST API, web UI, and remote-access pages in `~/work/gno.sh` and drive the changed pages locally per the Live QA Gate in `CLAUDE.md` before merging there.

### Investigation targets
**Required** (read before coding):
- `CLAUDE.md` sections "Live QA Gate" and "Avoiding Documentation Drift"
- `notes/pdf-remote-viewing-investigation.md` — the verification plan and the numbers measured on 2026-09-02

**Optional** (reference as needed):
- `docs/API.md:1397-1484` — doc-asset and vendor asset sections
- `docs/WEB-UI.md:256-295` — Native PDF Viewer

### Key context
- A VPN ping to the remote host measured 202 to 204 ms through a relay with no direct path on 2026-09-02. Compare against the current round trip when measuring.
- `~/work/gno.sh` was not present on this machine during planning; clone it before the docs mirror step.
- Confirm during the measurement which mechanism exposes `gno serve` on the remote host (a reverse proxy, a port forwarder, or an SSH tunnel) and record it; the spec's open question depends on it.
## Acceptance
- [ ] Cold network capture over the relay shows first paint under 2 s and under 30 requests for the fixture, or a recorded BLOCKED with the reason
- [ ] Warm reload capture shows under 100 KB of JavaScript transferred with hashed chunks served from cache
- [ ] Remote screenshot with DPR and viewport attached; if sharp, R7 met; if blurry, the capture is attached, a follow-up task is added, R7 stays unmet in the coverage table, and the spec stays open
- [ ] The exposure mechanism on the remote host is recorded in the done summary
- [ ] `assets/spa-production.json.gz` rebuilt and committed
- [ ] CHANGELOG, `docs/API.md`, `docs/WEB-UI.md`, `src/serve/CLAUDE.md` updated; `~/work/gno.sh` pages updated and driven locally
- [ ] `bun run lint:check` and `bun test` pass
## Done summary
Closed the documentation set and measured what could be measured from this machine. `docs/WEB-UI.md` documents the transport tier (one HEAD size probe; whole-file GET under 8 MB; 1 MB Range requests with background fetch at or above; ranged fallback on probe failure; ETag revalidation), the progressive first paint (page 1 before the rest is measured, one-step size correction with the scroll anchor held, per-page error slot), and the locality caveat in the Security table (a proxy is treated as remote; an SSH tunnel to `localhost` is the documented exception). `docs/API.md` names the remote inline Open original target (PDF only) and the viewer's HEAD probe. `src/serve/CLAUDE.md` records the shared capabilities type, the transport and first-paint modules, and the caching policy. CHANGELOG `[Unreleased]` carries one Added entry (`localClient`, reveal 403, locality-aware actions) and four Changed entries (doc-asset caching, SPA compression, PDF transport, first paint). The SPA snapshot was already fresh.

R3 (warm reload): MET locally. Production `gno serve` on loopback, headless Chromium 151 at 1380x880 DPR 2, generated 50-page 5.85 MB PDF, CDP wire accounting: an F5 reload transfers 0 bytes of JavaScript, all 42 hashed chunks from cache with no revalidation. The remaining 172 KB on a warm open is the entry HTML, the `/api/doc` JSON (167 KB of extracted text for that fixture), and a 539-byte doc-asset revalidation. Cold load on loopback: first paint 1.03 s, 55 requests, doc-asset traffic exactly one HEAD plus one Range-less GET.

R6 (cold over the relayed link): BLOCKED. Before-numbers from task .3 (pre-change build, about 203 ms round trip, largest remote PDF 3.07 MB): first painted page 37.2 s; 79 requests, about 8.8 MB; asset endpoint 26 requests (1 cancelled full GET plus 25 x 64 KB Range), no HEAD. After-measurement: the remote host has no shell access from this machine and still runs the pre-change build, so the user must update the remote install (and add a 5 MB / 50-page fixture, or revise the R6 numbers against the 3 MB file) before the final measurement. The local cold numbers are a loopback proxy only.

R7 (sharpness over the remote link): UNMET, capture BLOCKED for the same reason. Local proxy at DPR 2: the page-1 canvas backs at exactly 2.0x its CSS size (1400x1811 for 700x906) and the device-pixel crop is crisp, which rules out the render math as the blur cause on this build. The remote capture (DPR, viewport, browser, page count) is still owed; the spec must not close while R7 is unmet.

Exposure mechanism on the remote host (confirmed in task .3): a same-host HTTPS reverse proxy provided by the VPN, the reverse-proxy case in R4; not an SSH tunnel.

Hosted site mirror: BLOCKED. The site repository is not accessible from this account (private; ssh to GitHub hangs; `~/work` absent). The pages and points to mirror are listed in the run notes.

Follow-ups observed, not built: `/api/doc` answers about 167 KB of uncached extracted-text JSON on every open of a large PDF (the largest warm-path transfer on a slow link); `/api/doc/:id/similar` answers 503 without vectors on every warm reload; a measurement run wrote a stray `undefined/` config directory at the repo root (deleted by the conductor before commit; worth a guard on the env var that produced it).

Review: SHIP on round 1 (Opus, host backend); its two P3 doc wording notes (PDF-only qualifier in the CHANGELOG; the tunnel case in the Security table row) were applied after the verdict in a conductor commit.

stage: wave-join - ran (cherry-pick of the worker commit onto the target; no collision)
stage: impl-review - ran [round 1 SHIP] (model: claude-opus-5 via harness subagent, host backend)
stage: plan-sync - skipped(config: planSync.enabled != true)

2026-09-06 reconciliation: restored completion state from this existing summary and merged PR #206. Gordon confirmed all remaining work was completed and requested spec closure. Earlier BLOCKED/UNMET observations above are historical and superseded by that confirmation.
## Evidence
- Commits: a0195eb5, 1121d06898bdbcdf42563428aade2b2fa35ead89, d17ac7d8577c87fbd14a072deef3f39db121edae
- Tests: bun run lint:check -> clean, bun test test/serve/spa-snapshot-freshness.test.ts -> 2 pass, worker: focused Quick suites 16/16, 7/7, 85/85 pass; local R3 warm-reload measurement 0 B JavaScript, 42/42 chunks from cache (evidence in the run notes), R6 after-measurement and R7 remote capture: BLOCKED (remote host not updatable from this machine); hosted site mirror: BLOCKED (repository inaccessible)
- PRs: https://github.com/gmickel/gno/pull/206