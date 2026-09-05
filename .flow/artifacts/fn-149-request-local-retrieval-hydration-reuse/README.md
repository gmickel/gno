# Ask hydration evidence

`ask-before.json` was captured by executing the unedited Ask/context sources at
`d608b2c2461b024ebd90188824d1dd06b04848ab`, before the hydration plumbing edits.
It records SHA-256 hashes of those source files and the capture helper. This was
a shared working tree with concurrent changes elsewhere, not a clean native
release baseline. `ask-after.json` captures the same six scenarios with one
request hydration owner. The fn-143 `compareAcceptance` comparator reports exact
equality for all six cases. Tests also reject shortened actual model input and
removed citation/provenance output. No deterministic output was refreshed to
hide a mismatch. The initially abbreviated/padded commit metadata was corrected
to the full existing Git commit; only manifest receipt fingerprints changed.

The original 1,000-chunk CRLF fixture remains pinned at
`fd7fd4ba729385ffefcf59b423b9ca2b73891956f92cc97ac121e2fcae0d8c9e`.
Verified Capsule compilation requires canonical LF content. The separately
identified LF derivative is pinned at
`23366ddf3a5becdc5954f680603d9a2972a9809add0fb2566fa2556b184025cd`.
Its recipe is in `test/helpers/ask-hydration.ts`; source offsets are computed
from the actual canonical text before SQLite insertion. Two source documents
share that mirror and the same title. No fixture or quality threshold was
weakened. Tests pin both identities.

The harness uses real SQLite and production hybrid/answer/verified-Ask pipelines
with deterministic reranking and generation ports. Actual port arguments,
complete output, symbol-carried citation/planner provenance, evidence spans and
hashes are compared. Only the documented semantic duration telemetry is omitted.
Cases cover raw answer, verified answer, an unsupported verifier verdict that
fails schema validation and abstains, missing mirror, corrupt mirror, and an
indexed source-hash mutation during reranking. The last three preserve baseline
errors. These are model-double regression measurements, not native QA.

| Path | Before reads / rows / UTF-8 bytes | After reads / rows / UTF-8 bytes |
| --- | --- | --- |
| Raw Ask, full-context retrieval | 3 / 1,002 / 6,958,683 | 2 / 1,001 / 4,638,789 |
| Verified Ask, full-context retrieval | 5 / 3,002 / 11,596,473 | 4 / 2,002 / 9,277,578 |

Counters measure actual returned chunk/content rows and text bytes. They do not
measure total allocation, retained heap, or native residency. Candidate selection
is unchanged. These full-context reuse figures are separate from task .3's plain
targeted-path result: 1,000 to 1 selected chunk rows, BM25 2,063,895 to 2,062 text
characters and vector 2,063,895 to 2,069 characters. Characters and UTF-8 bytes
are different units and are not combined.

Freshness checks retain the original live store. A focused test corrupts stored
mirror content after Capsule assembly and proves verification detects it even
while the request owner still holds the old valid content. The existing verifier
checks index state before generation; this change adds neither filesystem rereads
nor post-generation freshness checks. No such guarantee is claimed.

CLI and SDK own/release hydration in `finally`; the SDK regression observes the
same owner throughout raw/verified generation, success and thrown failure, and
then sees an indexed title edit in a new request. The active-generation abort
test covers the internal signal-aware owner: active prompt/citation snapshots
survive release, new reads fail, and later owners see corrupt content and repair.
No new public cancellation option was added.

Focused CLI and SDK/REST/MCP tests use model doubles and run actual command and
surface handlers. Full repository gates, real native cold/warm pairs, process
memory measurements, final live QA and hosted docs remain host-owned acceptance.
