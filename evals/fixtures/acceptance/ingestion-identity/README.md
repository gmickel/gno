# Ingestion identity oracle v1

Synthetic, offline characterization for fn-147.1. The local manifest pins the
independent source strings, canonical chunks (including their final newline),
literal formatted inputs, model policy and required event/model-work counts.
This is a new scenario identity; fn-143 and memory baseline pins are unchanged.

The harness runs real filesystem sync, SQLite storage, journal reads and backlog
selection. A deterministic stand-in encodes exact formatted input and model into
vectors; a separate captured-input ledger records provenance. A vector with no
proven originating input cannot satisfy the oracle, even if its bytes match.
Counts represent individual backlog embedding inputs, not native batch calls.
The fixture policy explicitly uses complete short inputs without truncation.
It does not measure native model quality, performance, tokenizer limits or GPU
behavior. Vector persistence is synthetic SQL; production `embedBacklog` retry
and native vector-index integration require the dependent implementation tests.

The fn-143 paired comparator checks complete owner snapshots against independent
expected owners and separately created clean SQLite rebuilds. Owner identity is
the collection-relative path, joined from the actual document row to its current
mirror/chunk/model. Runtime numeric IDs cannot be compared across rebuilds.
Canonical mirror SHA-256, exact chunk text, vector bytes and captured input hash
are all compared; a shared mirror alone is insufficient. This is a store identity
check, not a claim that semantic search was executed.

Current failures are deliberately passing **characterization** tests:

- Alpha/Beta in either insertion order selects only the first owner's title.
  A clean rebuild also lacks one input variant and is rejected independently.
- Same-title duplicate and canonical-equivalent whitespace edit delete valid
  vectors and consume one unnecessary embedding input. After re-embedding,
  snapshots agree with the independent oracle and clean rebuild.
- Identical restoration remains inactive through repeated cycles and no-op syncs;
  the expected two reactivation events are missing. Clean rebuild remains active.

True content changes, model changes, filename rename and new-owner write failure
are controls. Full filesystem sync observes rename as create plus inactivate;
the fixture does not invent a rename-detection contract. An injected SQLite
document-write abort must leave the existing owner's vectors and journal intact.
Negative controls independently reject missing, wrong-title, stale-content,
wrong-model and unproven-input vectors.

Dependent tasks must replace known-gap assertions with repaired acceptance
assertions without changing the pinned inputs or weakening expected ownership.
Full repeated-restoration journal consumer, semantic search and mid-update
rollback QA remain required before the parent spec can pass.

Run from the repository root with an isolated, writable `TMPDIR`:

```sh
bun test ./test/ingestion/embedding-identity.test.ts ./test/changes/restoration.test.ts
```
