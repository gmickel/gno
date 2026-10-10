# Test runs leave temporary folders in TMPDIR

## Goal & Context
<!-- scope: business; source: user -->

GNO's test runs leave temporary folders behind that nothing removes. On Thor /tmp is tmpfs, so they use RAM: on 10 October 2026 /tmp held 19.6 GB while Thor was about 30 GB into zram swap, and GNO test leftovers were roughly 3 GB of that (1,287 `gno-*` folders older than a day, 2.3 GB, plus 108 `gno simulator package-*` folders, 781 MB). [user]

A full baseline run (6,169 pass, TMPDIR pointed at an empty folder) left 23 entries, about 99 MB: the packed GNO package from `test/llm/native-worker-integration.test.ts` (63 MB), the node-llama-cpp copy from `test/llm/simulator-install.test.ts` (37 MB), smaller `mkdtemp` folders from about a dozen other files, nine empty fixed-name roots from the CLI smoke suites, and four `gno-spa-*.sock` sockets left by servers the tests SIGKILL during cleanup. [inferred]

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [user] Every `bun test` run gets its own temp directory (TMPDIR, plus TEMP/TMP on Windows) from a preload, and the directory is removed when the run ends, so leftovers from any test go with the run without editing each of the ~256 `mkdtemp` callers.
- **R2:** [user] The heavy tests remove their own trees explicitly so one long run cannot pile up gigabytes: the simulator install and drift tests, and the packed native worker integration test.
- **R3:** [user] A check fails when a full run leaves anything in the TMPDIR it started with, and CI runs the suite through it.
- **R4:** [user] Product code (doctor, MCP, the resident server, import) is checked for temp files left during normal use; findings are reported, not necessarily fixed here.
- **R5:** [user] Nothing outside the run's own TMPDIR is deleted; existing /tmp contents belong to other sessions.

## Verification
<!-- scope: technical -->

- [inferred] `test/preload/temp-dir.test.ts` runs a leaking fixture under the preload with a fresh TMPDIR and asserts the TMPDIR is empty afterwards; `GNO_TEST_KEEP_TMP=1` keeps the run directory.
- [inferred] `bun run test:tmp-check` on the full suite: before and after numbers (entries and MB left in TMPDIR).

## Boundaries
<!-- scope: business -->

- [inferred] Unix sockets left by a SIGKILLed server are inherent to hard kills; the preload sweeps them in tests, and product code is not changed for them.
