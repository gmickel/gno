---
title: Memory
description: How gno remember and gno recall store and retrieve agent facts - the write-path taxonomy, explicit scopes, supersession, budgeted cited recall, context fencing and its limits, and what the memory slice deliberately does not do.
keywords: gno memory, agent memory, remember, recall, supersede, scopes, context fencing, local agent memory
---

# Memory

`gno remember` stores one fact. `gno recall` returns the current facts that
match a query, under a budget, with `gno://` cites and a receipt. Both are
core contracts exposed on every surface with one shared schema:

| Surface | Remember                                                        | Recall                                                       |
| :------ | :-------------------------------------------------------------- | :----------------------------------------------------------- |
| CLI     | `gno remember` ([CLI.md](CLI.md#gno-remember))                  | `gno recall` ([CLI.md](CLI.md#gno-recall))                   |
| MCP     | `gno_remember` (write set, `--enable-write`) ([MCP.md](MCP.md)) | `gno_recall` (read set) ([MCP.md](MCP.md))                   |
| REST    | `POST /api/memory/remember` ([API.md](API.md))                  | `POST /api/memory/recall` ([API.md](API.md))                 |
| SDK     | `client.remember()` ([SDK.md](SDK.md#remember--recall-memory))  | `client.recall()` ([SDK.md](SDK.md#remember--recall-memory)) |

Results are the same objects on every surface and validate against
`spec/output-schemas/memory-remember.schema.json` and
`memory-recall.schema.json`. Error codes (`MEMORY_*`) are identical
everywhere; each surface maps them onto its own envelope (CLI exit codes, MCP
`structuredContent.error`, HTTP status, `GnoSdkError.details.code`).

Memory lives in your own markdown files. The SQLite index stays derived and
disposable, exactly as for every other collection.

## Three write paths, one taxonomy

GNO keeps three ways of writing knowledge deliberately distinct:

| Path         | What it does                                                   | Granularity   | Where                                                  |
| :----------- | :------------------------------------------------------------- | :------------ | :----------------------------------------------------- |
| **edit**     | Updates an existing canonical note                             | a document    | Edit the file (editor, Web UI, `PUT /api/docs/:id`)    |
| **capture**  | Creates a genuinely new document with provenance               | a document    | `gno capture`, `gno_capture`, `/api/capture`           |
| **remember** | Upserts one fact with supersession and current-state reduction | a single fact | `gno remember`, `gno_remember`, `/api/memory/remember` |

Remember is not a second capture. A fact is one sentence or two (at most 4096
bytes); anything longer is a document and `remember` refuses it with
`MEMORY_TEXT_TOO_LARGE` and points at `gno capture`. Capture semantics did not
change with this feature; capture stays the creation primitive for notes.

Decide by asking what the thing is:

- An existing note is wrong or incomplete: **edit** it.
- A new meeting, idea, source, or note: **capture** it.
- A standalone fact an agent should be able to look up later ("deploys go out
  from `main` only", "Finn prefers trams"): **remember** it.

## Setting up a memory collection

A collection accepts `remember` only when its config declares it memory
managed. There is no CLI flag for it yet; edit the config
(see [CONFIGURATION.md](CONFIGURATION.md#memory-managed-collections)):

```yaml
collections:
  - name: memory
    path: /Users/you/notes/memory
    pattern: "**/*.md"
    memoryManaged: true
```

`remember` into any other collection fails with
`MEMORY_COLLECTION_UNMANAGED`, and `recall` reads only memory-managed
collections. When exactly one memory-managed collection is configured the CLI
defaults `--collection` to it. The flag changes nothing else: the collection is
indexed, searched, and egress-governed like any other, so `gno search` and
`gno query` see memory files as ordinary documents.

## The fact file

One fact per markdown file, written by GNO at
`facts/<YYYY-MM-DD>/mem-<16 hex>.md` inside the collection:

```markdown
---
title: "Deploys go out from the main branch only."
memory:
  recordId: "mem-10e4745c90d3b7ec"
  scopes: ["project:gno"]
  caller: "codex"
  session: "s1"
  createdAt: "2026-09-03T10:14:52.118Z"
  contentHash: "3f9c…"
  source: "Decided in the 2026-09-02 release sync"
relations:
  supersedes:
    - "gno://memory/facts/2026-09-01/mem-5b1d….md"
---

Deploys go out from the main branch only.
```

- `contentHash` is the SHA-256 of the normalized text (NFC, whitespace
  collapsed, trimmed). It is also the span hash that appears in recall
  receipts.
- `source` is the optional free-text evidence given at write time (`--source`,
  `source`); it is stored verbatim and echoed on the record in every result.
- `relations.supersedes` is the existing typed-edge mechanism; ingestion
  projects it into `doc_edges` like any other relation. There is no separate
  memory store.
- Files are canonical. You may hand-edit them, but a record that no longer
  satisfies the contract (missing frontmatter, bad hash, empty body, invalid
  scopes, ...) is excluded from managed recall and reported by `gno status`
  (`Memory:` section) and `gno audit` (`provenance.memory-record` rule). It
  stays visible to ordinary search.

## Scopes

Every `remember` and `recall` call names its scopes explicitly. **There is no
implicit global scope**: an unscoped call fails with `MEMORY_SCOPES_REQUIRED`
on every surface. Shared visibility is something you configure by choosing a
scope name that several callers agree on (`--scope shared`), never a default.

- 1 to 8 scopes per call. Each is trimmed, lowercased, NFC-normalized, and
  deduplicated (`Project:GNO` and `project:gno` are the same scope).
- Allowed characters: letters and digits, then `. _ : / @ -`; at most 64
  characters. Examples: `project:gno`, `family`, `client/acme`, `user@host`.
- Visibility is **any-intersection**: a fact is visible to a call when at
  least one of the call's scopes appears in the fact's scope list. A fact
  stored with `--scope family --scope shared` is returned to a recall scoped
  to `family` alone; a recall scoped to `project:other` does not see it.
- Scope filtering runs inside the retrieval query, not as a post-filter over a
  bounded candidate window, so a scope with few facts never comes back
  falsely empty behind a busier scope.

Scopes are a visibility partition, not an access-control boundary. Anyone who
can read the collection's files can read every fact; egress policy, not
scope, decides where derived output may travel.

## Identity

Every call carries a `caller` and a `session`. They are recorded in the fact
frontmatter and bound into every recall receipt.

| Surface | `caller`                                                 | `session`                                                         |
| :------ | :------------------------------------------------------- | :---------------------------------------------------------------- |
| CLI     | `--caller`, else `$GNO_MEMORY_CALLER`, else `cli:<user>` | `--session`, else `$GNO_MEMORY_SESSION`, else `ppid:<parent pid>` |
| MCP     | the client name from the `initialize` handshake          | the Streamable HTTP session id, or the stdio server instance id   |
| REST    | request body `caller`                                    | request body `session`                                            |
| SDK     | input `caller`                                           | input `session`                                                   |

MCP tool arguments never carry identity; it is mapped from the connection so
a client cannot claim to be another one.

## Remember

```bash
gno remember "Prod deploys from main only" --scope project:gno            # propose only
gno remember "Prod deploys from main only" --scope project:gno --add      # write
gno remember "Prod deploys from release/*" --scope project:gno \
  --supersede gno://memory/facts/2026-09-01/mem-5b1d….md \
  --predecessor-hash 3f9c… --json                                          # replace
```

`remember` first searches the current facts in the same scopes for
candidates (BM25 pool of 16, then cosine similarity >= 0.83 when the
collection's embedding model is already cached, otherwise normalized-token
Jaccard >= 0.5; the result's `matching` block says which). Then:

| Situation                                                               | Outcome                               | Written                                |
| :---------------------------------------------------------------------- | :------------------------------------ | :------------------------------------- |
| A fact with the same normalized text exists                             | `existing`, the record                | nothing (idempotent)                   |
| No decision given                                                       | `candidates`, likely and weak matches | nothing                                |
| `--add` / `decision: "add"`                                             | `added`, the new record               | one fact file                          |
| `--supersede <uri> --predecessor-hash <hash>` / `decision: "supersede"` | `superseded`, the successor           | one fact file with a `supersedes` edge |

The caller decides. GNO never adjudicates a likely match with a model; it
returns the candidates and waits for an explicit `add` or `supersede`.

Success means more than a file on disk: the write and the lexical index sync
complete under the shared write lease before the call returns, so the fact is
retrievable the moment `sync.status` reads `completed`. A `failed` sync is
reported honestly (the file exists, the index lags); rerun `gno update` for
that collection.

The CLI presents `--add` and `--supersede <uri>` as the primary spellings;
`--decision add|supersede` with `--predecessor <uri>` is the explicit,
scriptable form and means the same thing.

### Supersession

A fact is replaced, never edited in place:

1. Recall the current fact and take its `uri` and `contentHash`.
2. `remember` the new text with `--supersede <uri> --predecessor-hash <hash>`.
3. GNO verifies, under the write lease, that the predecessor exists, that its
   hash still matches (`MEMORY_PREDECESSOR_HASH_MISMATCH` otherwise), and
   that nobody has superseded it yet. It then writes the successor carrying
   `relations.supersedes: [<uri>]`.

Two writers racing to supersede the same predecessor get one successor and
one `MEMORY_SUPERSEDE_CONFLICT` (HTTP 409, CLI exit 4). The loser recalls
again and decides against the new current fact. Two current branches of one
fact cannot exist.

Superseded facts stay on disk and in ordinary search; `recall` excludes them
inside the query. Nothing is ever deleted by the memory contract (see
[What memory does not do](#what-memory-does-not-do)).

## Recall

```bash
gno recall "deploy branch" --scope project:gno
gno recall "kindergarten" --scope family --max-facts 3 --max-tokens 256 --json
```

`recall` is the fast path: BM25 over the memory collection, fused with the
vector leg when the embedding model is already cached, with query expansion,
graph expansion, and reranking off. It never downloads a model. The response
`retrieval.mode` reports `hybrid` or `lexical` with the reason. The MCP adapter
runs the lexical leg only, so a resident gateway does not load a model per
call.

- Only current facts come back; superseded records are excluded in the
  query.
- Budget: at most 8 facts under 512 estimated tokens by default
  (`--max-facts`, `--max-tokens`, `maxFacts`, `maxTokens`). Selection reuses
  the Context Capsule budget logic; `budget.omitted` counts facts that
  matched but did not fit.
- Each fact carries `uri` (`gno://…`), `text`, `scopes`, `caller`, `session`,
  `createdAt`, `contentHash`, `spanHash`, `supersedes`, `score`, and its
  `egressLineage`. The response-level `egressLineage` is the strictest policy
  across the returned facts; derived output inherits it.
- With nothing in scope the response has an empty `facts` list and a `hint`
  (`No memories in scope yet. Store one with: gno remember ...`). Every
  surface returns that line verbatim, so a fresh agent learns the write path
  from the empty read.

Cite recalled facts by their `gno://` URI, exactly as for any retrieved
document.

## Context fencing

Agents that recall and then remember in the same loop tend to feed GNO's own
output back in as a "new" fact. The fence exists to stop that loop where it
can be stopped honestly.

Every recall response includes a **receipt**: `caller`, `session`,
`issuedAt`, `memoryIds`, `spanHashes` (the `contentHash` of every returned
fact), and a `digest` over those fields. It is content-free; it carries no fact
text.

`remember` rejects, and writes nothing, when:

- the normalized hash of the submitted text matches a `spanHashes` entry on
  the presented receipt: `MEMORY_FENCED_REPLAY`. CLI: `--receipt <path>`
  pointing at a saved `gno recall --json` output or its `receipt` object;
  MCP/REST/SDK: the `receipt` field.
- the submission declares a `gno://` origin in `derivedFrom`:
  `MEMORY_FENCED_DERIVED`. Non-GNO origins (`https://…`, a meeting reference)
  are fine and are recorded as declared.

Receipts are surface-independent: a receipt issued by `gno_recall` fences a
`gno remember --receipt`, and the reverse.

### What the fence cannot do

Say it plainly: **a paraphrase without lineage cannot be fenced.** If an agent
recalls "Deploys go out from the main branch only", rewrites it as "only main
is deployed", presents no receipt, and declares no `derivedFrom`, GNO sees an
original fact and stores it. The fence is exact-span plus declared origin. It
is a guard against the accidental replay loop, not a proof of provenance, and
it depends on the calling agent passing the receipt it was given and declaring
what it derived from. Treat receipts as part of the agent's contract, not as a
security boundary.

## Concurrency and consistency

- Every memory write runs under the same shared write lease as `gno index`,
  `gno update`, and MCP writes (`.mcp-write.lock` next to the index). The
  core service acquires it; surface adapters never take a lock of their own,
  so an MCP `gno_remember` and a CLI `gno remember` serialise on one lease. A
  caller that cannot obtain it within the wait window gets
  `MEMORY_WRITE_LEASE_BUSY`.
- A fact is "current" only after write plus lexical sync succeed. A supersede
  additionally requires the `supersedes` edge to be projected before it
  returns `superseded`; if the projection fails the write reports
  `MEMORY_SUPERSEDE_PROJECTION_FAILED`, the predecessor still reads as
  current, and `gno update` retries the projection. Vector
  embeddings for new facts arrive with the next `gno embed`; recall's lexical
  leg finds the fact before that.
- Synced vaults (iCloud, Syncthing, git) replicate the files. The index on
  another machine sees a new fact after its own `gno update`; GNO does not
  coordinate memory across machines.

## Error codes

| Code                                                        | Meaning                                             | CLI exit | HTTP |
| :---------------------------------------------------------- | :-------------------------------------------------- | :------- | :--- |
| `MEMORY_TEXT_REQUIRED`, `MEMORY_TEXT_TOO_LARGE`             | Empty fact, or over 4096 bytes (use `gno capture`)  | 1        | 400  |
| `MEMORY_QUERY_REQUIRED`                                     | Empty recall query                                  | 1        | 400  |
| `MEMORY_BUDGET_INVALID`                                     | `maxFacts` / `maxTokens` not a positive integer     | 1        | 400  |
| `MEMORY_COLLECTION_REQUIRED`, `MEMORY_COLLECTION_UNMANAGED` | No collection, or one without `memoryManaged: true` | 1        | 400  |
| `MEMORY_COLLECTION_NOT_FOUND`                               | Unknown collection name                             | 1        | 404  |
| `MEMORY_SCOPES_REQUIRED`, `MEMORY_SCOPES_INVALID`           | No scopes, more than 8, or a malformed scope        | 1        | 400  |
| `MEMORY_IDENTITY_REQUIRED`                                  | Missing caller or session                           | 1        | 400  |
| `MEMORY_DECISION_INVALID`, `MEMORY_PREDECESSOR_REQUIRED`    | Bad decision, or supersede without URI + hash       | 1        | 400  |
| `MEMORY_PREDECESSOR_NOT_FOUND`                              | Predecessor URI is not a current memory record      | 1        | 404  |
| `MEMORY_PREDECESSOR_HASH_MISMATCH`                          | The predecessor changed since it was recalled       | 1        | 409  |
| `MEMORY_SUPERSEDE_CONFLICT`                                 | Someone else already superseded it                  | 4        | 409  |
| `MEMORY_FENCED_REPLAY`, `MEMORY_FENCED_DERIVED`             | Context fence (see above)                           | 1        | 400  |
| `MEMORY_WRITE_LEASE_BUSY`                                   | Shared write lease not obtained in time             | 4        | 409  |
| `MEMORY_SYNC_FAILED`, `MEMORY_QUERY_FAILED`                 | Index sync or retrieval query failed                | 2        | 500  |
| `MEMORY_SUPERSEDE_PROJECTION_FAILED`                        | Successor written but its edge did not project      | 2        | 500  |

MCP returns the code in `structuredContent.error` (plus `WRITE_DISABLED`
when the server runs without `--enable-write`); the SDK throws `GnoSdkError`
with the code in `details.code` and the `MemoryError` as `cause`.

## What memory does not do

These are exclusions, not gaps. Each one is a decision.

- **No automatic capture.** Nothing observes an agent's turns and stores
  facts on its own. Every fact is an explicit `remember` call.
- **No model in the write path.** GNO never extracts facts from prose,
  never decides whether a likely match is "the same" fact, and never merges
  records. Embeddings are used only to rank candidates; the caller decides.
- **No consolidation or dedup jobs.** Supersession is the only reduction.
- **No delete or forget.** Facts are superseded, never removed by the
  contract. To remove one, delete the file yourself and run `gno update`.
- **No memory Web UI.** Memory files are ordinary documents in the Web UI;
  there is no dedicated memory screen.
- **No implicit global scope.** Every call names its scopes.
- **No cross-machine coordination.** Files replicate through your vault
  sync; each index catches up on its own.
- **No harness adapters.** Framework-specific memory providers are a
  separate follow-up; the four surfaces above are the whole contract.

## Eval gate and fixtures

`bun run eval:memory` is the adapter gate for this slice: an opt-in, local-only
Evalite run (no CI, no network, no model download, no LLM judge) that drives
`remember`/`recall` through the SDK against a temp index and passes only at
100%. Matching and retrieval run lexical-only (BM25 + Jaccard), so every metric
is byte-deterministic across runs.

| Suite           | Metric                                                                                                                                                                                                                                | Gate                                                 |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------- |
| 1 upsert        | Decision behaviour per case (exact / paraphrase / clean)                                                                                                                                                                              | 1.0                                                  |
| 2 supersession  | Current-state precision; stale + racing supersedes conflict                                                                                                                                                                           | 1.0                                                  |
| 3 recall budget | Mean recall@5 (quality queries); cite validity; facts ≤ 8, tokens ≤ 512 on every recall, with the payload caps and `MEMORY_RECALL_MAX_*` pinned to those literals, and every budget query filling the 8-fact cap with facts left over | ≥ 0.8; 1.0; 1.0                                      |
| 4 fence         | Receipted replays + `gno://` derived origins rejected                                                                                                                                                                                 | 1.0 (paraphrase leak-through reported, not asserted) |
| 5 scopes        | Foreign-scope facts returned or reused on write; expected in-scope facts missing from a read                                                                                                                                          | 0; 0                                                 |
| 6 agent day     | Every turn as scripted; end state equals the golden                                                                                                                                                                                   | 1.0                                                  |
| 7 latency       | Recall p95 over 200 sequential calls                                                                                                                                                                                                  | ≤ 25 ms                                              |

The values live in `MEMORY_GATE` at the top of `evals/memory.eval.ts` and are
the contract: green there means the memory contracts are fit for harness
adapters (fn-135). A sub-threshold result is a finding against the memory
slice, filed as an fn-130 follow-up spec with the failing suite and row, never
absorbed by lowering a threshold or editing a fixture to match.

### Fixture format

Fixtures live in `evals/fixtures/memory/` as plain JSON, one file per suite,
and are pinned by sha256 in `manifest.json`; the loader refuses to run when a
pin is stale or when the directory holds a `.json` that is not in the pin list
(`MEMORY_FIXTURE_FILES` in `evals/helpers/memory-fixtures.ts`). Every file
carries `suite` and `description`; the rest is:

| File                    | Shape                                                                                                                                                                                                                                                                                                                                                        |
| :---------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upsert.json`           | `cases[]`: `id`, `class`, `seed[]` (stored first, private scope per case), `text`, optional `decision: "add"`, `expect` (`existing`/`candidates`/`added`), optional `likely`                                                                                                                                                                                 |
| `supersession.json`     | `cases[]`: `id`, `chain[]` (each entry supersedes the previous), optional `staleSupersede` (against `chain[0]`, must conflict), optional `conflictWriters[]` (raced against the head), `query`                                                                                                                                                               |
| `recall.json`           | `facts[]` (`id`, `text`) and `queries[]` (`id`, `query`, `relevant[]`, optional `kind: "budget"` for more relevant facts than the budget admits). At least one budget query is required, and its relevant facts must be sized so the 8-fact cap binds before the 512-token cap                                                                               |
| `fence.json`            | `facts[]` and `cases[]` (`id`, `query`, `paraphrases[]`); every recalled span is replayed with its receipt and with a `gno://` `derivedFrom`                                                                                                                                                                                                                 |
| `scopes.json`           | `facts[]` with `scopes[]`, `reads[]` (`query`, `scopes[]`, `expect: {includes}` with the in-scope fact ids that must come back; empty only for a pure negative read), `writes[]` (`text`, `scopes[]`, `expect`)                                                                                                                                              |
| `agent-day.json`        | `scope` and `turns[]`: `remember` (`text`, optional `decision`, `label`, `expect`, optional `likely` label), `supersede` (`predecessor` label, `text`, `label`, `expect`), `recall` (`query`, optional `scopes[]`, `expect: {includes, excludes, empty}`), `replay` (`from` recall turn, `expect`). `expect` on a write is an outcome or a memory error code |
| `agent-day.golden.json` | Path-free end state: `records[]` (`text`, `scopes`, `current`, `supersedes` as predecessor texts, sorted by text) and `recalls` (turn id → texts in rank order)                                                                                                                                                                                              |

Queries are BM25 conjunctions, so every query term must occur in the target
fact. A new scenario is one fixture edit away: add the case, run
`bun run eval:memory:fixtures` to refresh the pins (add `--golden` when the
agent day changed; review the golden diff before committing, it is the
expectation), then `bun run eval:memory`. A golden mismatch prints a line diff
to stderr.

## Binding defaults

| Setting                         | Value                | Where                                                 |
| :------------------------------ | :------------------- | :---------------------------------------------------- |
| Scopes per call                 | 1 to 8               | `MEMORY_MAX_SCOPES`                                   |
| Scope length                    | 64 chars             | `MEMORY_MAX_SCOPE_CHARS`                              |
| Fact size                       | 4096 bytes           | `MEMORY_MAX_FACT_BYTES`                               |
| Candidate pool (BM25)           | 16                   | `MEMORY_CANDIDATE_POOL`                               |
| Semantic likely-match threshold | cosine 0.83          | `MEMORY_SEMANTIC_LIKELY_THRESHOLD`                    |
| Lexical likely-match threshold  | Jaccard 0.5          | `MEMORY_LEXICAL_LIKELY_THRESHOLD`                     |
| Recall budget                   | 8 facts / 512 tokens | `MEMORY_RECALL_MAX_FACTS`, `MEMORY_RECALL_MAX_TOKENS` |

Constants live in `src/core/memory-types.ts` (re-exported from `src/core/memory.ts`) and `src/core/memory-record.ts`.
