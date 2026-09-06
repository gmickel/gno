---
satisfies: [R6, R7]
---
# fn-136-pdf-viewing-over-a-remote-link.6 Remote-link measurement (R6, R7) and hosted site mirror; needs the remote install updated

## Description
Close the remote-link half of R6 and R7 and mirror the docs to the hosted site. Split out because all three steps need access this machine does not have: a shell on the remote host to update its `gno serve` install, and access to the hosted site repository.

**Size:** S
**Files:** none in this repo beyond the task done summary and, if needed, a numbers revision in the spec's Acceptance Criteria; hosted site pages (REST API, web UI, remote access) in the external site repository
**Touches:** [.flow/tasks/fn-136-pdf-viewing-over-a-remote-link.6.md]

### Approach
- Update the remote install to this branch's build (the user owns that step) and confirm the exposure mechanism (a same-host HTTPS reverse proxy per task .3).
- R6: add a 50-page, about 5 MB PDF fixture to the remote collection (or revise the R6 numbers against the largest existing 3.07 MB file and say so), open it cold from this machine over the relayed link, and capture the network panel: request count, transferred bytes, time to first painted page, current round trip. Compare with the task .3 before-numbers (37.2 s first paint, 79 requests, 25 x 64 KB Range requests).
- R7: capture a screenshot from the remote browser with its reported device pixel ratio and viewport; the local DPR 2 check in task .5 already rules out the render math.
- Mirror the REST API, web UI, and remote-access pages in the hosted site repository and drive the changed pages locally per the Live QA Gate.

### Key context
- This task cannot start until the remote install is updated; it is not a candidate for an autonomous driver.
- The before-numbers and the local warm-reload and DPR 2 evidence are in the task .3 and .5 done summaries and in `notes/fn-136-run-evidence/` (gitignored).

## Acceptance
- [ ] Remote install updated to this branch's build and the exposure mechanism recorded
- [ ] R6 cold capture over the relayed link recorded against the before-numbers (or BLOCKED with the reason)
- [ ] R7 remote screenshot with DPR and viewport attached; R7 marked met in the spec coverage table only if the page is sharp
- [ ] Hosted site pages mirrored and driven locally


## Done summary
Completed remote-link verification (R6 and R7) and the hosted documentation mirror, as confirmed by Gordon on 2026-09-06. This reconciliation records owner-confirmed completion; it does not invent measurements or claim a new remote QA run.
## Evidence
- Commits: d17ac7d8577c87fbd14a072deef3f39db121edae
- Tests:
- PRs: https://github.com/gmickel/gno/pull/206