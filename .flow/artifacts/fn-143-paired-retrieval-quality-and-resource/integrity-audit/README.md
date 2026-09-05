# fn143–152 tracked artifact integrity audit

Snapshot: base 270c3a74f4f7a3aeb8a60462b4c8e1b4adf45462 through frozen HEAD a24ecec34b6a2b29114f92e1e3fe9559227fce2e. Scope: 1,948 added/changed tracked artifact files under fn143–152. Bytes read from Git blobs, not inferred from working-tree existence. Preexisting untracked fn129–142 and fn138/141 were not scanned. No GPU, SSH, product changes, or Git/Flow mutations.

## Result

All 800 gzip files decompressed successfully. All 1,217 JSON documents parsed completely; JSONL/NDJSON lines also parsed. No retained SQLite database, WAL, or SHM payloads found by names and database/WAL magic. Deliberate failed-native records were retained as evidence and were not treated as product failures.

Across 24 retained checksum inventories: 2,148 retained-byte/payload checks and 301 physical-source checks were evaluated. Six fn143 and ten fn145 source hashes correctly describe already-compressed physical input bytes, explicitly declared by gzip=false or transform=identity; they are not decompressed-payload mismatches. Original corpus pins, archive pins, machine-local logs, and excluded-database metadata are provenance inventories, not promises that those files ship as retained evidence. Explicit curationCorrection metadata likewise preserves the pre-correction source hash.

Two actual inventory findings:

1. CUDA packed manifest listed 40 Git-ignored Bun transpilation caches. Files existed locally but were absent from tracked history, producing 80 dangling compressed/payload checksum references. Parent authorized metadata-only correction. Manifest now contains 261 tracked artifacts / 4,945,556 compressed bytes. Every target passes git ls-files membership plus compressed/decompressed SHA256 checks. New excluded-bun-cache.json records the 40 untouched local cache files with hashes/sizes; README and curation-audit.json updated. Raw artifacts unchanged. Correction awaiting host commit.
2. fn148 native-bridge/preparation.json points to the current driver.ts path but pins the original preparation SHA d83c2b9416ec1bb2aead3f52d43b572cdf56ba45598b55052993d967ef9035d4. Current tracked driver SHA is 9a14793f1ebe2a2c4407c2f9e9e6ad4dd0056e1beb8b02a54e77c4bbec16e97f. The separately captured CUDA driver SHA is 117f3ef85043a047405acae3c832bd4fbf464456e3bd6f6a74c130fb9aba1dd9. Preserve the original preparation identity; do not silently replace its checksum with a later runner. Proposed correction: point the historical pin at separately retained original bytes if found; otherwise mark that historical source unavailable and separately pin the current and captured runners. Parent subsequently authorized correction. Exact original bytes were reconstructed from cuda-driver-captured.ts by reversing the recorded serialization-comparator hunk; the full 8,239-byte SHA256 exactly matches the original preparation pin. preparation-driver-original.ts now retains those bytes separately. preparation.json points to that historical file, records the reconstruction, and independently pins the current and captured runners. No inference or raw native evidence changed.

## Retained receipts rechecked

The public-reload SHA256SUMS, native-bridge rawSha256 inventory, and CUDA packed corrected payload/source identities passed their applicable checks. The integrity pass is byte/serialization validation, not a new quality verdict or native rerun. Physical-source checks establish correspondence only where source files remain locally available; frozen Git artifact hashes remain the portable authority.

Detailed per-check records, exact dangling paths, declared-transform handling, provenance exclusions, and frozen snapshot identity: notes/fn143-152-artifact-integrity.json.

The first attempted audit command hit the known /tmp quota before Python executed. The successful audit used direct Python -c, with no temporary heredoc or filesystem cleanup.

## Targeted post-correction verification

PASS: all 261 CUDA retained manifest targets are Git-tracked and pass compressed, decompressed, and physical-source SHA256 checks (783 checks). The recovered original preparation driver and both later fn148 runner pins independently match complete bytes and lengths. The new historical driver and exclusion metadata await host staging/commit; they are explicitly not claimed as already tracked. Both frozen-snapshot findings are resolved in the working tree. The frozen-snapshot issue list remains in the JSON for provenance, with a separate passing post-correction result.
