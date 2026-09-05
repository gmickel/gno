# CUDA supplemental lifecycle observations

Five declared screens ran sequentially after the host's CUDA grant. All completed
inside the 180-second/8192-MiB watchdog without a watchdog stop. The CUDA slot was
released to native_qa_setup afterward; no owned state-screen session remained.
All reports are **inconclusive or incomplete**, never promotion evidence. There
is one paired block per selected case/state, no stable p99 and no retries.

| Screen | Actual observations | Report status |
| --- | --- | --- |
| Fresh process | both roles completed; exact quality comparison passed; candidate 5828ms, baseline 5777ms, including process acquisition | parent cold report incomplete because another stratum failed |
| Resident model-cold | model state observed unloaded; baseline completed in 2303ms; candidate exited 134 with `pure virtual method called`, no next-query duration available | incomplete |
| Default post-idle | TTL 300000ms, idle 2500ms; models remained loaded; both completed in 250/252ms with exact quality equality | inconclusive |
| Expired post-idle | TTL 1200ms, idle 3000ms; models observed unloaded; both completed in 1606/1680ms with exact quality equality | inconclusive |
| Novel warm request | candidate repeated and genuinely different novel query completed in 268/265ms; baseline repeated completed in 262ms, but its novel session aborted 134 during primer before measured query | incomplete |
| Two-session overlap | two owned PIDs per role, positive request overlap 2542/2615ms; foreground fresh totals 6128/6194ms; foreground and background quality comparisons passed | inconclusive |

For the expired post-idle pair, GPU-accounted memory decreased from 1715470336 to
448790528 bytes in each role before the next request. RSS decreased from 1733394432
to 1341853696 bytes (candidate) and 1853509632 to 1416896512 bytes (baseline). These
separate counters are not added. The anticipated stale/disposed-context failure
did **not** reproduce in this pair; both next requests completed after model
reacquisition. The default-TTL pair retained unchanged GPU accounting despite a
roughly 90MB RSS decrease; no reclamation causality is inferred from that RSS drop.

Two native aborts remain unresolved, consistent with other acceptance observations
from the session. This screen does not attribute their cause to product or
instrumentation. Failed cold and novel samples retain raw diagnostics and resource
samples; unavailable request duration stays null. No failed row was replaced,
omitted, converted into a speedup or retried. No product, capture policy, golden
fixture or threshold was changed.

Primary pointers:

- `observations.json`: compact per-scenario status, comparison failures, durations,
  model state, memory boundaries, overlap and complete raw-session paths.
- `<scenario>/report.json`: full runner record, request/model inputs, raw resources
  and comparator results.
- `<scenario>/command.receipt.json`, `.stdout`, `.stderr`: exact command, exit,
  outer wall time and process-group RSS samples.
- `<scenario>/<side>/protocol/session-*/`: lossless compressed native replies,
  before/after model lifecycle state, stdout/stderr and readiness identity.
- `preparation-receipt.json`, `validation.json`: unchanged source fixture pin,
  online-backup database hashes and model-free preparation validation.

These observations use archived product commit
`270c3a74f4f7a3aeb8a60462b4c8e1b4adf45462` in both roles. They supplement the
original acceptance corpus; they do not alter its 51 scenarios or the active
warm30 databases. Two-session contention remains distinct from same-resident
background scheduler fairness.
