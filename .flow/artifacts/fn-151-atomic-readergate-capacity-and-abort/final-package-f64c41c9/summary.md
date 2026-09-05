# Final packaged fn151 / fn152 live evidence

Observed HTTP admission and production browser lifecycle checks passed against package 2.0.0 from `f64c41c97e196e3bffdba23bc1c006bca7489b28`. Existing mobile horizontal overflow remains. This is support evidence; the host owns the formal QA verdict and Flow closure. No product, Git, Flow, model, or GPU operations were performed.

## Package and isolation

Verified package supplied by native_package: `/home/gordon/.cache/agent-tmp/gno-final-package-f64c41c9/distribution/package`, using its supplied node_modules symlink to repository dependencies. Tarball SHA256 `56587f10c9969a795d6aa527c29fe8a057720a97d9f9e5de335daa996e706655`. Copied package manifest records all source/distribution pins. SPA compressed-file SHA256 `6fb55ab046765ac2ffc7cd8862ab25e865d9f567f4e00c8ee5828d3d09102322`; source-input hash `180edb2ba3d23f9360c200b4bea1560ecf9cdc0133518d6f2125d882e282da25`. Nine browser-requested JS assets were fetched again from the live proxy and byte-compared with the corresponding committed snapshot entries; all matched (`assertions.json`).

Scratch root `/home/gordon/.cache/agent-tmp/fn151152-final-f64c41c9`. GNO config/data/cache and XDG config/data/cache/state were scoped separately beneath `http`, `http-rerun`, and `browser`. `TMPDIR=/home/gordon/.cache/agent-tmp`, `GNO_OFFLINE=1`. Browser collection empty and synthetic; HTTP fixture contains only the synthetic Cobalt document. No private corpus, models, or real indexing jobs.

Production server command: `bun <package>/src/index.ts --config <scratch>/browser/config/index.yml serve --port 43952`. No `--dev`. Reused proxy on loopback43953 forwards HTTP to43952 and substitutes only sync/job status. Bun1.3.14; agent-browser0.35.1. Named Chromium sessions: `fn152-final-desktop`, `fn152-final-mobile`, `fn152-final-mobile-remount`.

## fn151 results and harness adaptation

Reused canonical live-api-probe with package-root imports. Initial attempt exit1 at its active-reader observation deadline: the historical delay wrapped runtime.withModelLease, which the current request path no longer calls. The 24 successful responses and queued-abort assertions had already completed. `fn151-initial.log` preserves this harness failure.

Moved only the existing8ms controlled CPU-free interval to after the real readerGate.acquire resolves, returning its unchanged release function. This makes the owned-reader window observable without replacing the gate, changing capacity, or introducing inference. Re-ran once with a fresh isolated HTTP database; exit0, `fn151-live.log`:

- R1:24 concurrent POST `/api/search`, all200, each full JSON deep-equal to same-run baseline; maxActive1 with configured limit1/queue64.
- R2: queued client abort removed its waiter while a second live waiter survived; active client abort followed by a successful identical search; finalActive0/finalQueued0.
- R3: real packaged startServer, Bun listener34935, ResidentRuntime and SQLite; successful shutdown and process exit. Full output payload captured. Different temp-root paths prevent whole-payload comparison with historical runs, so equality is asserted within this run.

Finer deterministic handoff schedules remain the committed ReaderGate regression suite's coverage. The active abort here is at the acquired-reader boundary during the controlled observation window, not a native inference cancellation test.

## fn152 results

Desktop1380x880 and mobile375x812 used the actual packaged production Collections route. Each run starts held qa-1 polling through **Re-index All**, navigates with **GNO** to Home before response, releases the response, then observes2500ms. Both event logs have exactly one request and one response, no subsequent qa-1 polls. Browser cancellation of the original request is expected.

**Manage Collections** → **Re-index All** starts qa-2: exactly3 requests per run, single sequential loop. Desktop gaps1004/1009ms; mobile1002/1003ms. These are observed intervals, not latency gates. Home navigation followed by2500ms leaves event logs byte-identical to the immediate departure snapshot.

Repeated remounts: desktop qa-3/qa-4 each one request, final qa-5 three requests with1006/1010ms gaps. Initial mobile rapid-driver loop attempted two clicks while Collections was still loading; retained `mobile-remount-actions.log` shows missing-control failures. This is not accepted as completed coverage. Added explicit visible **Re-index All** wait and reran only the missing repeated-remount scenario in a fresh named mobile session: qa-4/qa-5 each one request, qa-6 three with1003/1002ms gaps. Final2500ms absence window leaves event logs unchanged. Prior mobile qa-3 also stopped after one request.

Captured pending/away/returned screenshots, remount action snapshots, proxy request/response event logs, browser jobs network, three HARs, console and errors. Inspected desktop-returned, mobile-pending and mobile-remount-returned screenshots. All page error logs empty; console contains React DevTools information, no HMR warning. `assertions.json` validates all event counts and post-departure equality.

R1/R2/R3 observed through live routes/network. Delayed completed/failed/network-error/null settlement and callbacks after effect restart remain deterministic-only cases in IndexingProgress.dom.test.tsx; not separately claimed as live HTTP scenarios. Proxy job responses do not establish real server indexing completion. Historical old-production-bundle leak predates d8ba6af8; historical development passes and negative bundle evidence remain untouched.

## Existing finding and cleanup

Mobile document scrollWidth465 at viewport375/height812, scrollY0, again confirmed in `mobile-dimensions.json` and pending screenshot. Same P2 horizontal overflow already recorded in the fn152 QA receipt; no new causal attribution. Controls used for lifecycle testing remained usable. Scrolled returned screenshots show sticky header occlusion, consistent with prior observations; no new independently confirmed header-overlap defect claimed.

Closed all three owned named browser sessions. Stopped owned proxy PIDs1607705/1642974 and production server1607598. Server exited0 after shutdown; proxy termination143 expected. `/proc` absence and refused connections on43952/43953 verified in `cleanup.json`. HTTP probe exited0 and released its listener. No package bytes edited.

Evidence copied into new `final-package-f64c41c9` subtrees under the fn151 and fn152 artifact directories. `notes/fn151-152-final-evidence.json` indexes them and their hashes. No formal review invoked, per user; host retains final acceptance.
