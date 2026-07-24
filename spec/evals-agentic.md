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
  promotion.ts
  project-affinity-contract.ts
  project-affinity-outcome.ts
  project-affinity-promotion.ts
  project-affinity-runtime.ts
  verified-ask-outcome.ts
  verified-ask-promotion.ts
  demos/context-capsule.ts
  registry.ts
  report.ts
  report-artifacts.ts
  cli-options.ts
  cli.ts
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
    context-capsule-demo.schema.json

evals/fixtures/agentic-retrieval/
  manifest.json
  tasks/<opaque-task-id>.json
  oracles/<opaque-task-id>.json
  corpus/<opaque-task-id>/<opaque-collection>/<opaque-file>.md
  agent-model.lock.json
  baseline/
    README.md
    fixture-agent/
      report.json
      canonical.json
      observations.json
      report.md
      verified-ask-promotion.json
      verified-ask-promotion.md
    optional/{qmd,local-model}/     # local opt-in evidence; not authoritative
  demos/
    context-capsule.json
    context-capsule.md
```

## Separate project-affinity promotion

`project-affinity-cases.json` defines two controlled vector-distance pairs over
the existing `t456ef70` (`c015`/`c115`) and `t567f081`
(`c016`/`c116`) task/corpus/oracle identities. The separate closed
`project-affinity-promotion@1.0` artifact hash-binds those manifest identities;
it does not add tasks to the authoritative 24-task, 144-receipt matrix or
change `BenchmarkReport@1`.

The target collection starts `0.02` behind, then receives one trusted local
`+0.03` contribution. Promotion requires correct top-1 to strictly improve to
`2/2`, exact required evidence to remain retained, zero URI-rank/required
evidence-coverage loss across all 24 hard-collection tasks, and zero loss for
`t012ab3c`, `t123bc4d`, `te8f901a`, and `tf901a2b`. It also gates hard-filter
isolation, absent/disabled/unavailable/untrusted exact zero lanes, shared
auxiliary cap receipts, and structural store-call/candidate bounds. Latency is
not a gate.

The committed artifacts are
`baseline/fixture-agent/project-affinity-promotion.json` and `.md`. They contain
only GNO evidence URIs, hashes, scores, and redacted aliases—never temporary
roots, raw project hints, or absolute paths. The controlled synthetic lane
isolates the score seam and makes no general workload superiority claim.

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

For Capsule evidence bundles, `content` is byte-for-byte the production MCP
`gno-context-agent-v1` text projection. Exact evidence is not duplicated in the
normalized evidence field. The benchmark charges the complete normalized
agent-visible envelope containing that text once; the full canonical Capsule
in MCP `structuredContent` is application-only and excluded. This target models
hosts that keep structured data outside model context. Hosts that expose both
text and `structuredContent` must charge both and cannot cite this promotion
result without a separate run.

Canonical JSON recursively sorts object keys by code-unit order, preserves array
order, and rejects `undefined`, non-finite numbers, and non-JSON values. It
excludes all observations. Unchanged deterministic inputs therefore produce
byte-identical canonical JSON and SHA-256.

`agentCalls` counts every valid outer-agent tool choice, including a choice
whose adapter call times out or throws, whose returned envelope is malformed,
or whose result is rejected before delivery by context/token accounting.
Each canonical call records `deliveredToAgent` and a nullable `failureCode`.
Undelivered calls retain a valid returned result and known backend invocation
count when available; otherwise they use a closed synthetic error result. They
always contribute zero model-visible bytes and have no per-call token
measurement. Aggregate measured tokens sum delivered calls only, preserving
any earlier measured context; with no delivered measured call, tokenizer
comparability remains `null`. The undelivered call is unique, terminal, bound
to the receipt failure code, and excluded from the outer-agent history.
`backendInvocations` counts adapter-internal
retrieval, fetch, rerank, or synthesis operations. Promotion efficiency uses
`agentCalls`; backend invocations are reported separately and cannot substitute
for them.

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
fingerprints. It also verifies three pinned model identities by URI, filename,
native cache filename, byte size, and streamed SHA-256:

- `hf_ggml-org_embeddinggemma-300M-Q8_0.gguf`
- `hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf`
- `hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf`

The lock deliberately does not claim a separately verifiable model-repository
revision: the already-cached GGUF identity is pinned by exact URI, native
filename, byte size, and whole-file SHA-256. The committed lock's raw bytes are
also SHA-256 pinned before any checkout or model validation, and that raw lock
identity is included in the adapter configuration fingerprint.

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
receipts, identity-bearing task scores, Capsule replay proofs, exact
environment/methodology, and known limitations. The environment includes the
package and Bun versions, platform/architecture, Git commit/dirty state,
fixture version/fingerprint, selected agent, and trial schedule.

The report `canonicalFingerprint` hashes a non-self-referential projection:
the fingerprint field itself and volatile receipt observations are excluded;
environment provenance, methodologies, limitations, native index identities,
canonical receipts, identity-bearing scores, exclusions, Capsule payload bytes
and hashes, and promotion results remain included. `report.json` is schema
valid. `canonical.json` contains that exact projection. `observations.json`
holds environment, build observations, and full-identity receipt observations;
committed temporary paths are projected to `<temp>`. `report.md` is the readable
summary. The six files are staged and directory-renamed as one baseline set.
The verified Ask files are a separate attributable outcome lane; they do not
rename the Capsule retrieval promotion in `report.json`.

## Reproducible Context Capsule demo

`demos/context-capsule.json` is a closed, canonically fingerprinted projection
of one frozen exact-identifier task from the authoritative fixture-agent
report. It contains exactly three lanes in fixed order: the lexical-only
no-GNO baseline, shipped GNO MCP query/get primitives, and the Context Capsule.
Every lane retains its complete normalized trajectory receipt, score, exact
evidence coordinates and hashes, final stop outcome, agent/backend call counts,
model-visible UTF-8 bytes, token availability, and matching-lifecycle latency.

All three lanes must share the task, outer agent, trial, seed, lifecycle,
corpus, prompt, tool, model, runtime, and canonical effective-index
fingerprints. The generator selects exactly one receipt and score per full
identity and rejects ambiguous multi-trial input. Adapter configuration
fingerprints may differ. The Capsule projection additionally retains its
normalized `retrieval.request`, effective index fingerprint, capability states,
fallback list, and complete model-visible payload. Validation parses the
delivered evidence bundle and compares those values, then recomputes every
displayed lane metric from the embedded receipt and score.

Source provenance distinguishes each source run's clean `runGitCommit` from
the later Git commit that contains the generated demo artifact. The artifact
does not attempt to embed its own containing commit. Its report and Verified
Ask fingerprints and projected fields must match the canonical linked source
artifacts.

The readable `context-capsule.md` is generated from the JSON contract. It
states the single-trial variance limitation, reports tokens as unavailable
without one pinned comparable tokenizer, and limits its claim to the measured
controlled task. It discloses that the chosen task is the sole cold
current-GNO-failure / Capsule-success case in the 24-task authoritative cohort,
that the Capsule lane is an evaluation-only lexical prototype, and that its
latency is not shipped-product latency. It cannot be used as a general
product-superiority claim.

The adjacent Verified Ask block is an attributable but separate
`answer_enforcement` proof. It binds the clean-Git canonical fingerprint of the
frozen 22-pair `raw_ask`/`verified_ask` artifact, retains the two declared
missing-evidence exclusions, and exposes only answer-accuracy and unsupported-
substantive-claim metrics. Those metrics are never merged into or labeled as
retrieval metrics.

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
failed task/trial/seed/lifecycle/agent pair set `P`. Baseline adapter identity
must be exactly `gno-mcp`; candidate identity must be exactly `capsule`. Corpus,
prompt, tool, model, and runtime fingerprints must match. Adapter config and
native index fingerprints may differ by design. Every score record must match
its receipt identity.

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

Unsupported substantive claims must strictly decrease on a comparable paired
cohort:

```text
unsupportedClaims_capsule < unsupportedClaims_gno
1 - unsupportedClaims_capsule / unsupportedClaims_gno
```

The report records both counts and the reduction. A missing paired baseline,
an identity mismatch, or a zero unsupported-claim baseline makes this reduction
unavailable/non-comparable; GNO reports that state rather than fabricating an
improvement.

All denominators must be non-zero. Abstention-only tasks use their completion
predicate and do not fabricate substantive claims. Every fixture-agent Capsule
task must also emit byte-identical canonical Capsule payload JSON and matching
SHA-256 across the scored run and one unchanged-input replay. Empty,
non-canonical, wrong-task, or synthetic sentinel payloads fail. Missing pairs,
duplicates, identity mismatches,
pairwise or aggregate accuracy loss, denominator failure, threshold miss, or
nondeterminism fails promotion.

## Verified Ask promotion formulas

The authoritative fixture-agent write additionally runs a separate 22-task
outcome lane. It excludes only the two declared expected-missing/abstention
tasks. Every included task must contain exactly one required substantive claim;
missing, duplicate, extra, or mismatched pairs fail closed.

The compatible cohort is an independent frozen contract, not inferred from the
artifact under validation:

```text
t012ab3c t0a1b2c3 t123bc4d t1b2c3d4 t2c3d4e5 t3d4e5f6
t456ef70 t4e5f607 t567f081 t5f60718 t6071829 t6780192
t718293a t7891a03 t8293a4b t93a4b5c ta4b5c6d tb5c6d7e
tc6d7e8f td7e8f90 te8f901a tf901a2b
```

The exact exclusions are `t234cd5e` and `t345de6f`, both with reason
`expected_missing_evidence`. Removing or replacing a complete receipt/score
pair and resealing every derived fingerprint still fails validation.

The baseline executes the production raw Ask path:
`searchHybrid` → `generateGroundedAnswer` → `processAnswerResult`. The candidate
executes production `buildVerifiedAsk`. Each pair shares the immutable native
index, task goal, collection, structured search modes, deterministic answer
agent/model fingerprint, and initial answer draft. Receipt and score identities
bind task, lane, trial, seed, and agent. Pairing also requires identical fixture,
index, request, and model fingerprints.

Four fixed, diverse tasks receive an unsupported deterministic draft in both
lanes. The other 18 receive the oracle-supported draft. This controlled
adversarial subset tests enforcement at the product boundary; it does not claim
general model quality.

For every pair and in aggregate:

```text
answerAccuracy_verified(p) >= answerAccuracy_raw(p)
mean(answerAccuracy_verified) >= mean(answerAccuracy_raw)
unsupportedSubstantiveClaims_verified < unsupportedSubstantiveClaims_raw
```

`verified-ask-promotion.json` contains canonical receipts, identity-bearing
scores, exact cohort/exclusions, metrics, and the gate result.
`verified-ask-promotion.md` is its readable projection. Temporary collection
paths and timings are excluded from the canonical contract; fixture, index,
request, model, exact answer, citation hashes, verification status, and scored
outcome remain bound. The evaluator parses the typed claim from the exact final
product answer and scores it against the independent fn-97 oracle; it
recomputes receipt, answer, score, and artifact fingerprints rather than
trusting harness-assigned claim or score fields. Raw and verified lane semantics
are validated independently. A supported final answer is exactly one encoded
typed claim followed by its lane citation (`[1].` or one
`[evidence:<sha256>].`); prefixes, extra claims, and trailing prose are invalid.
An abstention must equal the production abstention text and contain no
citations. Authoritative generation refuses a dirty Git checkout and records
the exact clean source commit.

## Commands

Contract tests are ordinary offline tests:

```bash
bun test test/eval/agentic
bun run eval:agentic:demo
```

The runner is local and opt-in:

```bash
bun run eval:agentic
bun run eval:agentic -- --adapter gno-mcp,lexical,capsule --task t0a1b2c3 --lifecycle cold --agent fixture --timeout-ms 30000
QMD_REPO=/path/to/pinned/qmd QMD_MODEL_CACHE=/path/to/cache bun run eval:agentic -- --adapter qmd
```

Filters are CSV lists and reject empty, duplicate, or unknown values before
adapter preparation. Defaults are all tasks, `gno-mcp,lexical,capsule`, both
lifecycles, and the fixture agent. qmd is lazily registered and never runs by
default. A requested unavailable qmd lane produces the complete requested
harness-error matrix/report and exits `2`; it never disappears or downgrades.

Exit `0` means a complete run and, when applicable, both promotions pass. Exit
`1` means the complete Capsule or verified Ask promotion gate failed. Exit `2`
means invalid CLI, preflight, harness, or requested-adapter failure. `--write`
accepts only a full
24-task/two-lifecycle lane: the fixture-agent three-adapter lane writes the
authoritative baseline, while qmd and the three-trial cached-local-model lane
write only under `baseline/optional/`. Filtered or mixed writes are refused and
can never overwrite the authoritative baseline.

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
- Capsule retrieval/planning remains a deterministic fixture prototype; its
  model-visible serializer and omission accounting are the production MCP
  contract.
