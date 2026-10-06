# A deleted note intermittently stays indexed

## Problem

Twice in fn-203 soak runs, a note deleted from disk stayed active in the index for longer than the 3-minute convergence window, while everything else converged:

- smoke run 1 (`--seed 1`): `notes/d29/new-886.md` after a churn phase that included directory deletes and recreations under `d29`.
- torture `sleep-wake` (`--seed 3`): `notes/d28/new-3755.md` after the resident was SIGSTOPped for 90 s during churn and then resumed.

A rerun of the same smoke seed converged, so the miss is timing dependent. Likely areas: a delete inside a directory that is deleted and recreated before the watcher flush, or events lost or coalesced while the resident is suspended.

## Acceptance Criteria

- **R1:** Reproduce reliably (loop the soak classes above, or a focused watcher test for delete-then-recreate of the parent directory and for events during suspension) and confirm the mechanism.
- **R2:** Fix it so a deletion is always reflected, with a regression test for the confirmed mechanism.
- **R3:** 20 consecutive soak smoke runs and torture `sleep-wake` runs converge with no extra documents.
