# Large pivot-table workbook makes 2.8.2 indexing run away in memory

## Goal & Context
<!-- scope: business; source: user -->

After upgrading to 2.8.2, the first `gno update` on a macOS host never finished. It ran for 54 minutes at ~99% CPU with nothing written to the index, and its resident memory reached 35.9 GB; a repeat `gno index <collection>` reached 74 GB within 8 minutes. Indexing the one responsible file alone in an isolated config reproduced it: more than 15 GB within 15 seconds, no progress. SIGTERM stopped every run within seconds. [user]

The file is an Excel workbook: 8.3 MB compressed, 4 worksheets totalling about 40 MB of sheet XML, two pivot caches whose record parts are about 17 MB and 15 MB of XML, and about 1.2 MB of shared strings. The same file converted and indexed without trouble on 2.8.0 (first index) and during 2.8.1's post-upgrade full re-read, so this is a 2.8.2 regression. 2.8.2 changed link extraction for non-Markdown sources (fn-195); converted workbook text is a likely place to look but this is unconfirmed. [paraphrase]

Excluding the file by name restored normal indexing (the rest of the collection re-read in 6 seconds). [user]

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [paraphrase] Converting and indexing a workbook with the shape above completes with memory bounded well below the machine's RAM (target: peak RSS under 4 GB) and in time roughly linear in its size, as it did on 2.8.1. A generated fixture of similar shape (several large sheets plus large pivot cache records) reproduces the regression before the fix and passes after it.
- **R2:** [paraphrase] One pathological file can never stall or exhaust memory for a whole run: per-file conversion and post-conversion processing run under a bounded budget (time and memory, configurable), and a file that exceeds it is skipped with a recorded error code (visible in `gno status` and the audit), while the rest of the collection indexes normally. The skipped file stays pending for a later explicit retry.
- **R3:** [inferred] The run reports which file it is working on when it overruns (a status or verbose line naming the collection-relative path), so an operator does not need to bisect the index database to find it.

## Boundaries
<!-- scope: business -->

- [inferred] No change to which files are indexed or how workbook text is extracted beyond fixing the regression; pivot caches may be skipped if they were never meant to be indexed.

## Decision Context

Part of the unattended-operation hang inventory in fn-180: every long-running GNO process must be bounded, observable and stoppable. This case was stoppable (SIGTERM worked) but neither bounded nor observable. [paraphrase]

## Resolved via Codebase

- Candidate area: non-Markdown link handling introduced by fn-195 (`src/core/link-inventory*.ts`, `src/core/links.ts`) applied to converted workbook text; workbook conversion in the converter pipeline.
- Related: fn-180-investigate-detached-serve-hot-loop-raw (hang inventory).
