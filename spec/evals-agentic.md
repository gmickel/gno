# Agentic Retrieval Evaluation Contract

This specification defines GNO's deterministic end-to-end retrieval outcome
benchmark. It measures whether an agent finds enough evidence, cites it exactly,
and stops efficiently. It complements ranking evals; it does not replace them.

The standard test suite validates fixtures, schemas, hashing, scoring, and
production ingestion without a model, network access, API key, or global GNO
configuration. Generation-backed benchmark runs remain local and opt-in.

## Versions and layout

All contracts currently use `schemaVersion: "1.0"` and closed JSON Schema
draft-07 objects. Unknown properties fail validation.

```text
evals/agentic/
  types.ts
  canonical.ts
  strict-json.ts
  validation.ts
  fixture-db.ts
  scoring.ts
  adapter.ts
  agent.ts
  fixture-agent.ts
  local-model-agent.ts
  runner.ts
  runner-contract.ts
  runner-receipt.ts
  runner-trial.ts
  runner-validation.ts
  schemas/
    agent-task.schema.json
    hidden-oracle.schema.json
    final-envelope.schema.json
    trajectory-receipt.schema.json
    benchmark-report.schema.json

evals/fixtures/agentic-retrieval/
  manifest.json
  tasks/<opaque-task-id>.json
  oracles/<opaque-task-id>.json
  corpus/<opaque-task-id>/<opaque-collection>/<opaque-file>.md
  agent-model.lock.json
  baseline/                         # populated by later runner work
```

The first fixture version contains 24 original synthetic tasks and 34 Markdown
documents under the MIT license. It covers exact identifiers, ambiguity,
multi-document comparisons, meeting decisions, temporal questions, typed
relationships, code/documentation, multilingual prose, and missing-evidence
abstention. The manifest hashes the exact bytes of every task, oracle, and
corpus file. Its separate corpus fingerprint hashes the sorted logical inventory
of task ID, collection, relative path, and source hash.

## Public task and hidden oracle boundary

An `AgentTask` contains only:

- an opaque ID and category
- the agent-visible goal and instructions
- public `claimKey`, tagged `valueType`, required, and substantive flags
- allowed tool names and call/context budgets
- opaque collection names available to the task

The outer agent receives the result of `projectAgentVisibleTask()` and normalized
tool results. It never receives the oracle, fixture manifest, setup paths,
adapter labels, or evaluation metadata.

The normalized tool contract is one deeply frozen `search`, `get`, and
`multi_get` schema shared by every adapter. An adapter declares unsupported or
unavailable capabilities without changing that schema. Result
`resultRole` is agent-visible and closed: `candidates` requires a subsequent
source read, `source` is an exact read, and `evidence_bundle` is complete enough
to support a one-call final envelope. The fixture agent responds to this role,
never to an adapter ID. A one-call-budget task may finalize exact candidate
evidence rather than exceed its budget.

A separate `HiddenOracle` contains normalized expected typed values,
normalizer ID/version, required/optional/forbidden evidence, expected missing
claims, collection/filter expectations, completion predicates, and hidden leak
canaries. Every task and oracle filename is an opaque ID. Validation scans every
agent-visible task, path, and corpus file for the oracle-only canaries.

Corpus text necessarily contains the evidence an agent is meant to retrieve;
the isolation guarantee concerns evaluator answers, normalizers, qrels,
completion predicates, and other oracle metadata.

## Structured final envelope

`FinalEnvelope` deliberately has no answer or prose field:

```json
{
  "schemaVersion": "1.0",
  "claims": [
    {
      "claimKey": "launchDate",
      "value": { "type": "date", "value": "2026-09-14" },
      "citations": []
    }
  ],
  "gaps": [],
  "abstained": false,
  "stopReason": "complete"
}
```

Claim values are tagged unions: `string`, `number`, `boolean`, `string[]`,
`date`, or `identifier`. Dates are ISO calendar dates. Gaps use one of
`missing_evidence`, `conflicting_evidence`, `budget_exhausted`, or
`tool_unavailable`. Stop reasons are `complete`, `abstained`,
`budget_exhausted`, `tool_unavailable`, or `error`.

Strict parsing rejects comments, trailing commas, duplicate properties at any
depth, prose, and malformed tagged values. Semantic validation
then rejects unknown or duplicate claim/gap keys, value types that disagree with
the public claim definition, missing required claims, and uncited required
claims. Invalid output is scored as unsupported; it is never ignored.

## Exact evidence semantics

Evidence coordinates contain:

- `gno://<collection>/<relative-path>`
- lowercase SHA-256 of the source's exact UTF-8 bytes
- 1-based inclusive `startLine` and `endLine`
- lowercase SHA-256 of the exact selected span bytes
- separate source- and span-hash provenance

For line selection only, the fixture loader converts CRLF and lone CR to LF.
It then selects the inclusive lines and joins them with LF. It does not append a
synthetic final newline, trim whitespace, or normalize Unicode before hashing
the span. A source hash never performs newline or Unicode normalization.

Fixture corpus files are additionally required to already be stable under GNO's
production Markdown canonicalizer. That keeps production-ingested mirror line
coordinates aligned without changing the exact source-byte contract.

`harness_observed` means the harness derived the hash from exact observed bytes.
`backend_provided` means the adapter returned the hash. Normalized qmd results
will preserve these separately rather than synthesizing backend hashes from the
hidden oracle.

## Immutable corpus and native indexes

`loadAgenticFixture()` verifies every manifest hash, schema, task/oracle pairing,
evidence coordinate, span hash, leak canary, and corpus fingerprint. It exposes
one frozen `CorpusSnapshot` for all adapters.

An adapter builds its native immutable index during unmeasured preparation from
that snapshot. `recordAdapterNativeIndex()` binds each adapter-specific index
fingerprint and volatile build observations to the same corpus fingerprint.
Cross-adapter index bytes need not match.

`prepareGnoNativeIndex()` is the reference production-ingestion helper. It:

1. materializes the exact manifest-pinned bytes into a temporary root once;
2. opens an explicit temporary SQLite path with the production tokenizer;
3. registers the complete collection set;
4. runs production `SyncService` conversion, canonicalization, chunking, FTS,
   tag, link, and relationship projection with deterministic concurrency one;
5. verifies processed/error counts and active document source hashes;
6. fingerprints stable URI/source/mirror/index inputs while excluding document
   IDs, timestamps, temp paths, and timings.

It never loads or writes global GNO configuration or a production database.
Cold and warm cohorts for an adapter must reuse the same prepared native index.

## Trajectory receipts

A `TrajectoryReceipt` has two top-level partitions.

### Canonical

The canonical partition contains every decision-affecting input and output:

- task, adapter, trial, seed, lifecycle, and agent IDs
- normalized calls, arguments, results, evidence, and stable error codes
- distinct outer `agentCalls` and internal `backendInvocations`
- exact model-visible UTF-8 bytes for every tool result, including repeated
  reads and model-visible errors
- measured token counts and tokenizer fingerprint, or `null` when unavailable
- structured final envelope, stop reason, and failure class
- explicit tool/span/token/hash/lifecycle capability states, including
  `unsupported` and `unavailable`
- corpus, prompt, tools, model, runtime, config, and index fingerprints

The exact agent-visible result projection includes status, `resultRole`, content,
citeable observed coordinates/hashes/provenance, evidence text, and error code.
Adapter backend hashes, backend-hash diagnostics, call accounting, tokenizer
accounting, temp paths, and oracle data are excluded from both the agent history
and its UTF-8 byte count.

Canonical JSON recursively sorts object keys by code-unit order, preserves array
order, and rejects `undefined`, non-finite numbers, and non-JSON values. It
excludes all observations. Unchanged deterministic inputs therefore produce
byte-identical canonical JSON and SHA-256.

`agentCalls` counts outer-agent tool choices. `backendInvocations` counts
adapter-internal retrieval, fetch, rerank, or synthesis operations. Promotion
efficiency uses `agentCalls`; backend invocations are reported separately and
cannot substitute for them.

### Observations

The observations partition contains volatile data:

- recording timestamp
- preparation, startup, model-load, tool, driver, and end-to-end timings
- process/resource measurements
- temporary paths and redacted diagnostics, including volatile failure messages

Each timing is either `{ valueMs: <non-negative>, unavailableReason: null }` or
`{ valueMs: null, unavailableReason: <non-empty reason> }`. Changing an
observation cannot change the canonical receipt fingerprint.

Preparation/index build is outside both lifecycle cohorts. Cold end-to-end time
starts before fresh process startup against the prepared index and includes the
first scored call. Warm time starts at the first scored agent step after exactly
one discarded readiness probe on a preserved process/model/index. Reports never
compare unlike lifecycle states.

## Failure and cohort accounting

Failures are `harness_error`, `agent_error`, or `product_error`; successful
receipts use `none`. Harness failures are attempted pairs but are excluded from
product scoring with an explicit reason. They cannot silently reduce a cohort.
Malformed tool/final envelopes, duplicate JSON keys, timeouts, and unavailable
requested adapters fail closed. Adapter calls receive an `AbortSignal`; a timed
out or state-unknown warm call excludes the remaining cohort explicitly rather
than running alongside a leaked request. Deterministic agent errors do not
invalidate later warm pairs.

The runner rejects empty, duplicate, or malformed task, adapter, lifecycle, and
trial schedules before preparation. Every attached adapter must preserve its
prepared owner identity, config fingerprint, capability contract, and index
fingerprint. Preparation, reset, tool outcomes, runtime/session identities,
token measurements, agent steps, and tool arguments are closed runtime-validated
before they enter a receipt or reach a product adapter. Tool listing, session
construction, inference, calls, and best-effort disposal are bounded.

## Outer-agent lanes and lifecycle

The standard fixture agent is a pinned answer-free state machine. It selects one
preferred lexical cue per public claim, performs `search`, reads returned URIs
for candidate results, reduces exact observed lines into declared typed claims,
and stops or abstains within the public budgets. Ordinary candidates require a
`get` or `multi_get`; a complete evidence bundle can stop after one call.

The optional cached-local-model lane is fail-closed. `agent-model.lock.json`
pins one exact Hugging Face URI, whole-GGUF SHA-256 (also binding its embedded
tokenizer), tokenizer identifier, step/output budgets, and exactly three unique
paired trial IDs/seeds. `GNO_AGENTIC_MODEL_PATH` must point at that already
cached exact file. Preflight performs strict duplicate-safe JSON parsing and a
streaming SHA-256 check before model initialization. It never resolves a remote
endpoint, downloads a model, reads an API key, or falls back to the network.
Model output is one strict JSON tool action or `FinalEnvelope`; prose and
duplicate keys are agent errors.

## Product-faithful GNO MCP comparator

The `gno-mcp` adapter measures the shipped stdio MCP process rather than
importing a retrieval pipeline. Its normalized surface maps `search` to
`gno_query`, `get` to `gno_get`, and `multi_get` to `gno_multi_get`. The adapter
lists the real product tools during unmeasured preparation and fails closed if
any mapped field is missing from the shipped input schemas. It sets
`lineNumbers: false` on reads so exact returned bytes can be bound to fixture
line coordinates; this is a public MCP option, not an evaluator shortcut.

Preparation materializes the immutable corpus into an isolated config/data/
cache root, runs production ingestion, and embeds every active chunk before
scoring. `gno-models.lock.json` pins the exact embed, rerank, expansion, and
generation GGUF URI, byte size, and SHA-256. `GNO_AGENTIC_GNO_MODEL_DIR` may
point at a cache containing those exact files. The harness streams and verifies
all four files, rewrites the isolated config to `file://` URIs, passes
`--offline`, sets `HF_HUB_OFFLINE=1`, and rejects missing or mismatched vectors.
It never downloads a model or mutates the user's config/database/model cache.

Cold trials create a fresh stdio MCP process against the already prepared
index. Warm trials preserve one process and first issue exactly one discarded
`gno_query` readiness probe with `fast: true`; the probe must report
`vectorsUsed: true`. Process startup and tool latency are measured separately.
GNO does not expose model-load timing independently from its first query, so
that observation is explicitly unavailable rather than inferred.

Normalized candidate and source payloads strip absolute paths, mtimes, and
volatile error messages. Non-default-index URI decoration is removed because
the isolated adapter already owns one explicit index. Citeable evidence is
emitted only when returned text exactly matches the snapshot's inclusive line
span. Evidence is line-atomic even when GNO returns a multi-line chunk. Source
and span hashes are recomputed from observed fixture bytes. Because GNO does
not return a backend span hash, the closed backend hash pair is explicitly
unavailable; the product source hash remains in normalized candidate metadata.
Repeated reads remain repeated calls and bytes. Query backend invocation
accounting includes lexical/vector retrieval, expansion, reranking, and graph
stages declared by structured MCP metadata.

The native index may contain the whole fixture, but every reset establishes one
task visibility boundary. Single-collection searches are automatically scoped;
multi-collection tasks must name one of their declared collections. Foreign
collections and foreign `get`/`multi_get` URIs are rejected before MCP traffic,
and any foreign result returned by the product fails the trial without exposing
its content to the outer agent.

Fake-process tests are part of the normal offline suite. The isolated real
stdio smoke is opt-in with `GNO_AGENTIC_RUN_REAL_MCP=1`; it uses the exact model
lock and performs no network access. Successful MCP envelopes are validated
before normalization; malformed or source-hash-mismatched output fails closed.
Preparation cancellation is threaded through model verification, embedding,
and MCP preflight, with child termination and isolated-root cleanup.

## Optional pinned qmd comparator

The `qmd` lane is explicit opt-in and fail-closed. `QMD_REPO` must be an
absolute, clean checkout at commit
`e428df76bc0274d9e93eb7ca3e95673315c42e90`. Preflight verifies the exact
origin, commit, clean tree, package manifest, lockfile, executable entrypoint,
and the dynamically listed MCP tool name, description, and input-schema
fingerprints. It also verifies three pinned model identities by URI, revision,
filename, byte size, and streamed SHA-256:

- `hf_ggml-org_embeddinggemma-300M-Q8_0.gguf`
- `hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf`
- `hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf`

`QMD_MODEL_CACHE` may name an absolute read-only cache containing those exact
files. The adapter never resolves qmd from `PATH`, uses a global install,
downloads a model, pulls or checks out the repository, or mutates the checkout
or supplied cache. Missing, stale, dirty, mismatched, or schema-drifted inputs
are harness errors, never skips or degraded comparisons. The intentionally
strict preflight therefore fails until the exact checkout and model artifacts
have been prepared.

Preparation runs qmd's update, embed, and status lifecycle outside measured
trials, then verifies the native index. `QMD_CONFIG_DIR`, `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME`, `INDEX_PATH`, and data paths are isolated under one temporary
root; locked models are copied and reverified there. Cold trials start a fresh
stdio process on a byte-identical clone of the pristine prepared database.
Warm trials retain one process after exactly one discarded full query using the
task goal, declared collections, `rerank: true`, and readiness-only intent so
models load without colliding with a scored query cache key.

qmd result ranges are parsed from the inner `@@` coordinates and accepted only
when returned bytes exactly match the fixture snapshot. Evidence is emitted as
atomic lines with harness-observed source and span hashes; backend hashes remain
the complete null pair with an explicit unavailable reason. The same pre-call
task scope and post-result isolation rules apply as for GNO. qmd does not expose
reliable internal backend invocation counts, model-load timing, or token
measurements, so invocation-accounting capability is `false`, its count is
zero with a diagnostic, and those observations remain explicitly unavailable.

Committed reports record attempted pairs, scored pairs, every exclusion,
receipts, task scores, environment/methodology, and known limitations.

## Deterministic scoring

The scorer compares typed claims and exact citations with the hidden oracle. It
reports:

- completed and supported claims
- unsupported claims and invalid outputs
- missing required claims/evidence
- forbidden evidence
- correct abstention
- premature `complete` stops
- unnecessary reads from call/context budgets and, for designated tasks,
  unexpected evidence
- collection and filter correctness
- substantive claims linked to complete supporting evidence

No LLM judge participates in these gates. Optional model judging may assess
prose in separate experiments, but cannot override deterministic promotion.

## Capsule promotion formulas

Promotion compares Capsule and current GNO only over the identical non-harness-
failed task/trial/lifecycle pair set `P`.

For every pair:

```text
success_capsule(p) >= success_gno(p)
```

Aggregate accuracy must also have no loss:

```text
sum(success_capsule) / |P| >= sum(success_gno) / |P|
```

Efficiency gates are:

```text
1 - sum(agentCalls_capsule) / sum(agentCalls_gno) >= 0.25
1 - sum(modelVisibleUtf8Bytes_capsule) / sum(modelVisibleUtf8Bytes_gno) >= 0.35
```

Claim linkage is:

```text
linkedSupportedClaims_capsule / substantiveClaims_capsule >= 0.95
```

All denominators must be non-zero. Abstention-only tasks use their completion
predicate and do not fabricate substantive claims. Every fixture-agent Capsule
task must also emit byte-identical canonical Capsule payload JSON in two
unchanged-input replays. Missing pairs, duplicates, identity mismatches,
pairwise or aggregate accuracy loss, denominator failure, threshold miss, or
nondeterminism fails promotion.

## Commands

Contract tests are ordinary offline tests:

```bash
bun test test/eval/agentic
```

The opt-in runner contract reserved for subsequent tasks is:

```bash
bun run eval:agentic -- --agent fixture --adapter gno-mcp,lexical,capsule --lifecycle cold --write
QMD_REPO=/path/to/pinned/qmd bun run eval:agentic -- --agent fixture --adapter qmd --lifecycle cold --write
```

## Limitations

- The corpus is controlled regression evidence, not a representative claim
  about every agent, domain, or language.
- The deterministic fixture agent will be narrower than a general model.
- Model-visible UTF-8 bytes are the primary cross-adapter context measure;
  tokens compare only under one pinned tokenizer.
- Latency remains environment-specific and only compares matching lifecycle
  cohorts.
- qmd is an optional exact-revision comparator and is never required by the
  standard test suite.
- The eval-only Capsule adapter does not establish the production fn-98 API.
