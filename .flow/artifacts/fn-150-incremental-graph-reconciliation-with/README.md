# fn150 final graph QA

Task remains in progress pending the host's integrated gates. Mechanical graph
equivalence passes after the document-ID lookup fix. Browser QA retains the
existing graph-header overflow finding tracked with fn151/fn152.

## Identities and isolation

- Initial source archive: `dd38f777`, including fn150.4 and startup fixes.
- Post-fix archive: `635293b6c309cf3be34facf30b4fbc1802167cae`.
- Bun 1.3.14, Linux x64. Synthetic files and disposable databases only.
- Runtime roots: `/home/gordon/.cache/agent-tmp/gno-fn150-qa/`.
- Empty owned model caches, `GNO_OFFLINE=1`, `HF_HUB_OFFLINE=1`; no model ports,
  GPU work, native downloads, or private-vault benchmark.
- Corpus contract: `fixture-manifest.json`, unchanged fn143/fn150 oracle fixture.
  Scaling additions have separate hashes in `scaling-fixtures.json`.

## Public consumers

`public-consumers.ts` drives real CLI processes and a real loopback server on
port 3385. MCP uses a real initialized Streamable HTTP session. Each of ten
mutations compares five CLI, five REST, and five MCP captures against a fresh
full-reconciliation oracle: graph, scoped graph, backlinks, traversal, impact.
Mutations: initial, add, ambiguous, unique, delete, restore, rename, title,
configuration, source disappearance. Underlying typed edges are also compared
using the existing paired comparator before consumer reads.

Root-level `*-incremental.json`, `*-oracle.json`, and `public-matrix.json` preserve
the initial failure: renamed identical bytes retain an inactive old-path row with
the same document ID. REST backlinks selected that row, returning zero backlinks
versus two in the oracle. URI-based CLI/MCP reads correctly returned two.
`docid-before.log` reproduces the shared lookup failure on the old archive.

The fix orders shared document-ID lookup by active status, then insertion ID.
It preserves the earliest active winner and inactive-only fallback; it does not
add collision disambiguation semantics. The real adapter/REST regression covers
multiple active copies and the inactive-only case. Three obsolete hardcoded
schema-version assertions were separately updated to the latest migration.
`docid-after-final.log`: 60 passing tests, 1,180 assertions.

`postfix/` contains all new raw captures and a fully equal ten-mutation matrix.
`postfix/checks.json` additionally verifies scoped nodes belong to the selected
collection and scoped edges remain between returned nodes. Global versus scoped
degrees and active/restored visibility remain in the raw graph responses.
Normalization removes only runtime timing/generated timestamps and isolated
fixture-root prefixes; it preserves supported diagnostics, identities and edges.

Reproduction uses `GRAPH_QA_SOURCE`, `GRAPH_QA_ROOT`, `GRAPH_QA_OUT`, and
`GRAPH_QA_COMMIT` to select an archive, fresh runtime, fresh output directory and
recorded commit. Run `bun public-consumers.ts` with those variables and an owned
`TMPDIR`; do not reuse an existing runtime or overwrite these baseline captures.

## Actual sync scaling

`scaling.ts` drives file-backed SyncService operations. SQL triggers count actual
`doc_edges` inserts, deletes and updates; `getContent` calls count content reads.
Each number is one synthetic observation, not a statistical estimate or an
attribution of private-vault elapsed time. Full raw sync results and projection
state appear in `scaling.json`.

| Documents | Operation | Milliseconds | Content reads | Edge mutations |
| ---: | --- | ---: | ---: | --- |
| 101 | No-op | 0.560 | 0 | None |
| 1,001 | No-op | 1.317 | 0 | None |
| 5,001 | No-op | 1.609 | 0 | None |
| 101 | Target title change | 21.381 | 2 | 100 deletes |
| 1,001 | Target title change | 208.391 | 2 | 1,000 deletes |
| 5,001 | Target title change | 1,062.196 | 2 | 5,000 deletes |
| 101 | All source references change | 119.357 | 200 | 100 inserts |
| 1,001 | All source references change | 1,877.112 | 2,000 | 1,000 inserts |
| 5,001 | All source references change | 27,360.424 | 10,000 | 5,000 inserts |

The narrow case deliberately has incoming references from every outside source;
all dependent edges must change, while content reads remain two. Broad sync cost
still grows substantially with changed sources. This does not measure graph
response computation or claim a response-cache improvement.

## Recovery and browser evidence

`recovery-task4-evidence.json` and `recovery-task4.log` preserve fn150.4's actual
sync fault tests at commit e4e7c266: a subprocess exits 73 during the outer graph
transaction, reopening retains old edges plus dirty state, and retry equals the
oracle without duplicating source-journal events. This is captured provenance,
not a new task5 execution claim.

`browser-evidence.json` records the QA-skill-selected agent-browser driver,
loopback target, viewport, DOM, console, network and screenshot paths. Desktop
1380×880 renders three linked nodes/two edges; changing the collection selector
to targets hides nodes with no internal links under the default linked-only view.
Mobile 390×844 renders the graph but header controls overflow (scroll width 472),
reproduced twice. This is the existing fn151/fn152 P2 finding, not a duplicate
new issue. API network requests returned 200; no browser errors were captured.
The owned browser session and server were closed after capture.

Focused initial graph gates passed 17 tests/167 assertions (`baseline.log`).
Typed lint and formatting passed for changed source/tests; docs verification
passed 15 checks with two existing skips. Final repository lint/typecheck/full
tests belong to the host after concurrent work integrates. Hosted gno.sh changes
remain queued until the PR stage; no hosted edits or deployment were performed.
