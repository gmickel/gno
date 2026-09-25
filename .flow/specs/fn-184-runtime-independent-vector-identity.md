# Runtime-independent vector identity

## Goal & Context
<!-- scope: business -->

A vector partition's identity currently mixes what actually defines the vector space (model weights, formatter, dimensions, context and truncation policy) with incidental runtime details: the Bun version, the native binding version, the GPU/CPU backend and the CPU math thread count. Any change to those details silently starts a new `shadow` partition and a full re-embed, even when the vectors would be the same. [inferred]

Two reported failures follow from this. Switching the embedding backend (`GNO_LLAMA_GPU=false gno embed --yes`) did not resume a ~1,900-chunk backlog; it forked a new partition and began re-embedding a ~15,600-chunk corpus, hit an inference deadline after ~1,000 chunks, and `gno status` then reported against the incomplete shadow partition as if the index had lost its embeddings, although the active GPU partitions were intact. [user] Separately, a scheduled CLI run on one Bun version and the desktop app on another built separate embedding sets for the same index instead of sharing completed work. [user] Nothing warned before either fork.

Make vector identity depend only on what shapes the vectors, reuse an existing partition whenever the current runtime measurably produces the same vectors, and make any genuine fork explicit and visible. [inferred]

## Architecture & Data Models
<!-- scope: technical -->

- **Partition key.** Key partitions on the model weights fingerprint, embedding formatter/profile, dimensions, context size and truncation policy. Runtime details (Bun version, native binding version, backend, thread count, platform) become recorded provenance, not identity. [inferred]
- **Measured compatibility.** The first time a runtime meets an active partition, re-embed a small fixed sample (about 8) of chunks already stored in that partition and compare against the stored vectors. At or above a cosine threshold the partition is compatible and reused; otherwise the runtime is incompatible with it. Cache the verdict per (partition, runtime provenance) in one small table so the check runs once per new runtime, not per query. No separate probe corpus. The threshold is set from measured GPU/CPU and cross-Bun-version comparisons on the default model before implementation and recorded in this spec. [inferred]
- **Incompatible runtime.** `gno embed` from an incompatible runtime does not fork silently (R3). Queries from an incompatible runtime never mix vector spaces: they fall back to lexical retrieval and say so in results and status. [inferred]
- **Migration.** Existing fingerprints cannot be decomposed. On first open under the new key, run the same sample check against each existing partition with the same model and dimensions; re-key the most complete compatible partition as active under the new key; leave the rest as `shadow`. Crash-safe and idempotent. [inferred]

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Runtime-only changes (Bun version, native binding version, CPU thread count, and GPU/CPU backend where measured vectors match) reuse the existing active partition with no re-embedding. Tests: an index embedded under one runtime provenance and opened under another with identical vectors resumes the backlog in the same partition. Errors: a verdict write failure falls back to a fresh check next time, never to a fork. [inferred]
- **R2:** A runtime whose sampled vectors fall below the threshold is recorded incompatible; its queries use lexical retrieval only, with an explicit notice in results and `gno status`. Errors: an empty partition or too few stored chunks to sample is reported as unverified, not compatible. [inferred]
- **R3:** A genuine fork is never silent. Before a run that would build a new partition, `gno embed` states that it will build a separate partition, the full chunk count and an estimate, and requires explicit confirmation (non-interactive: an explicit flag); `--yes` alone does not confirm a fork. [user]
- **R4:** `gno status` and `gno doctor` report against the partition retrieval actually uses and list every other partition with state, owner count and a readable provenance label (e.g. CUDA, Metal, CPU), so an incomplete shadow partition never appears as the index having lost embeddings. A documented, supported command drops an abandoned shadow partition without touching active ones. Tests: status with a shadow present; removing the shadow restores the prior status exactly. [user]
- **R5:** The one-time migration re-keys existing indexes without re-embedding when a compatible partition exists, is idempotent across restarts, and survives a crash mid-migration. Errors: an ambiguous migration keeps all existing partitions and reports it rather than guessing. [inferred]
- **R6:** Docs for `GNO_LLAMA_GPU` / `NODE_LLAMA_CPP_GPU`, status/doctor, and embedding troubleshooting state what does and does not change vector identity and how to remove a shadow partition. Update CLI/API/MCP/status schemas, the shipped skill and `gno.sh`. [inferred]

## Boundaries
<!-- scope: business -->

- [inferred] No change to embedding models, chunking, truncation limits or the formatter; no cross-model vector reuse.
- [inferred] No configurable threshold knob or compatibility allow-list; the measured check is the only mechanism.

## Decision Context
<!-- scope: both -->

- [inferred] Measuring vector equality on the index's own chunks replaces a maintained list of "compatible" runtime versions, which would drift with every Bun or binding release.
- [inferred] Split from fn-180 (resident serve incident): this changes when vector identity differs, which fn-180 explicitly excluded. fn-180's status/recovery work does not depend on this spec.
- [inferred] Bundled clients that pin their own GNO build (for example a desktop shell plugin) stop needing lockstep version bumps for vector reuse; they still track releases for features and schema compatibility.
