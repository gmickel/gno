# Bounded resident shutdown implementation acceptance

Product9bb46bcaebd5fa5bcdea6e1cc6218a8b86c6e977. Full worker handover follows; its initial in-progress status is historical. Implementation accepted from focused tests and actual synthetic child/source-CLI observations. Packaged native CUDA/Metal and real daemon SIGTERM acceptance remain task5.

# fn-146-cancellation-and-bounded-background.4 handover

Status: in_progress; implementation frozen for host Git/Flow/full gates and task5 physical QA. Host supplied pre-task base 2e3cd21cb476c45806ca618c919aa06626fcf454. No Git/Flow mutation, formal review, implementation bridge, GPU model execution, SSH or subagent dispatch. Exact 29-file ownership inventory is notes/fn146.4-owned-files.txt; final SHA256 values are in notes/fn146.4-evidence.json. Host owns lifecycle, commits and acceptance.

Resident shutdown now runs one monotonic 5s drain + 5s abort-settlement + at most 1s owned-child-exit budget. Admission/job acceptance stop before asynchronous cleanup; scheduler/watchers/listener cleanup participate in that same clock. Repeated runtime disposal joins the same promise. Existing accepted jobs retain their independent request-disconnect lifetime, receive shutdown cancellation through their own controllers, never publish a completed result after cancellation and release their write-lock handle once. Incomplete job records use the existing failed schema. Job records remain process-local; durable embedding backlog is the restart mechanism.

SqliteAdapter now fences ordinary store access, synchronously rolls back a suspended outer transaction, revokes its shared nested ALS token, and releases the serialized writer only after rollback. Queued writers revalidate the actual connection identity after admission; old callbacks cannot commit or access a reopened connection. Forced shutdown closes cached raw handles synchronously before awaiting native exit. Existing committed checkpoints persist, interrupted checkpoints roll back and actual VectorStats backlog enumeration discovers all unfinished chunks after reopen. During shutdown, ordinary store access/commit caps SQLite busy_timeout to the remaining settlement deadline. Rollback/close failure remains an error and prevents unsafe owner-lock release; native cleanup is still attempted.

The runtime reaches owned adapters directly before port cleanup can block. Native retirement has one wakeable loop and timer: a later shutdown request tightens that same deadline and can force its existing wait, without leaving the original grace timer running. Actual child exit alone clears ownership and settles the native ledger. OS kill/exit failure returns a bounded explicit PID-bearing error, retains the unreaped owner/quarantine/capacity, and makes later admission or explicit model disposal fail promptly rather than start a replacement. Concurrent disposal signals the same retirement loop, and affected caller results are delivered once. Other processes are untouched.

Daemon installs its stop wait before initial sync and races a stuck initial sync against it. Serve/daemon surface cleanup starts without waiting ahead of runtime disposal and participates in its clock; source-level startup failure cleanup also uses the shared runtime drain. Detached parent SIGTERM grace is now 12s, allowing the resident's 11s internal sequence before its existing identity-checked parent SIGKILL fallback. No new CLI/configuration timeout flag, schema, migration, precision, model input or retrieval parameter was added.

## Verification

- Pre-edit canonical quick baseline: 17 pass / 56 assertions; notes/fn146.4-baseline.log.
- Expanded affected suite including full SQLite adapter, native lifecycle, scheduler/runtime, jobs, daemon and detach: 156 pass / 1507 assertions; notes/fn146.4-regressions.log.
- Combined affected surface/store/native/checkpoint suite: 122 pass / 461 assertions across 14 files; notes/fn146.4-verify.log.
- Final runtime/store/MCP lifecycle plus canonical quick suite after orchestration extraction and model-admission guard: 37 pass / 173 assertions across eight files; notes/fn146.4-final-verify.log.
- Final real-vector backlog restart/store fence, native fault, resident deadline and parent grace focused suite: 66 pass / 197 assertions; notes/fn146.4-final-focused.log.
- Retirement tightening plus existing real-IPC cancellation/native lifecycle, runtime and foreground SIGINT regression: 42 pass / 230 assertions; notes/fn146.4-retirement-final.log.
- Last native owner follow-up (including subsequent request/model-disposal after OS failure): 17 pass / 133 assertions; notes/fn146.4-native-final.log.
- Final repository TypeScript check green: notes/fn146.4-typecheck.log.
- Final owned type-aware lint: 24 TypeScript files, zero warnings/errors; notes/fn146.4-lint.log.
- Final formatting: 29 owned files green; notes/fn146.4-format-check.log.
- Documentation verification: 15 passed, zero failures, two model-cache-dependent checks skipped; notes/fn146.4-docs.log. Initial parity failure was the concurrent skill-owner edit; host synchronized its mirrors and the rerun passed.

Counts overlap and must not be summed as unique tests. No frozen fn143 fixture/oracle/baseline was changed. Intermediate failures were test-fixture response shape, the intentionally changed scheduler-stop ordering assertion, and lint warnings; final affected checks pass.

## R4/R6 coverage and host follow-up

- test/serve/resident-runtime.test.ts: simultaneous stuck request/background/scheduler/surface work shares one configured drain/settlement clock; admission closes, scheduler stops first, repeated disposal joins, store fence precedes close. Existing cleanup failure and graceful ordering tests remain green.
- test/store/shutdown-fence.test.ts: real migrated DB with three chunks and one committed vector; paused second-vector transaction and queued writer; synchronous rollback/close/reopen; closed old raw handle; revoked late callback, one completion; two pending chunks after reopen; later transaction resumes remaining work to zero backlog. Also checks shutdown busy-time cap.
- test/core/job-shutdown.test.ts: accepted job survives parent abort, shutdown owns its cancellation, no false completed typed result, lock released once despite late callback.
- test/llm/native-shutdown.test.ts: real synthetic IPC child ignores cancellation/shutdown, is reaped while unrelated child survives; exactly one caller result. Fake OS no-exit and kill-error retain ownership and return promptly. Existing retirement tightened from a long deadline reuses the same promise. Later admission and explicit model disposal fail without creating a generation.
- test/cli/detach.test.ts: deterministic clock proves default grace permits an 11.1s resident exit without parent SIGKILL. test/cli/daemon.test.ts proves stop during a stuck initial sync reaches disposal (injected runtime).
- test/serve/shutdown-lifecycle.test.ts drives the actual source CLI foreground serve SIGINT through scripts/serve-shutdown-smoke.ts against isolated synthetic state. This is actual CLI evidence; daemon/in-flight SIGTERM tests in this worker are unit coverage, not packaged native CLI proof.

Host/task5 still owns actual packaged daemon/SIGTERM with native work in flight, integrated REST/MCP/cancellation/background/shutdown physical evidence, full project gates and final CUDA/Metal comparisons. No physical or full-project readiness claim from this handover. Hosted gno.sh reconciliation belongs to host; coupled repository DAEMON/CONFIGURATION/CLI/spec CLI/CHANGELOG are updated.

The finite policy assumes the parent event loop can run. No JavaScript timer can preempt synchronous JavaScript, an already-running SQLite statement or OS blocking; this boundary and the ordinary-store busy-wait cap are explicit in the docs. Cached raw DB access outside the store API has no ALS/per-access timeout fence, but the connection is synchronously closed after rollback before native-exit waiting. Native OS termination failure never implies PID absence.

stage: impl-review - skipped(config: user explicitly disabled formal reviews)
