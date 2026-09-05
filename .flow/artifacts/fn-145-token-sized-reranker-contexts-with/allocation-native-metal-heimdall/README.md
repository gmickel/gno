# Heimdall physical Metal allocation comparison

PASS for this bounded allocation/parity case. Apple M4 Max, 128 GiB, Darwin 27 arm64; a distinct host from the prior 16 GiB Ivan pressure failure. No historical failure is replaced.

Frozen GNO 2.0.0 source f64c41c97e196e3bffdba23bc1c006bca7489b28; actual npm archive SHA256 56587f10c9969a795d6aa527c29fe8a057720a97d9f9e5de335daa996e706655. All 909 shipped files verified byte-for-byte before each run, against package-pins.json. The source was not modified. Existing Bun 1.3.14 and node-llama-cpp 3.19.1; runtime/native binary identities in identity.json and arm headroom receipts.

The same six full prepared passages and query from the prior CUDA experiment are retained in fixture.json, with original capture provenance/hash and identical reranker GGUF SHA256 22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48. Only model file location differs by host. No passage/token truncation, layers, batch, precision, or safety-check changes. Auto control removes only the contextSize option inside the actual owned native child; library-selected capacity is observed, never forced.

Actual sized context 768 versus auto 40960. Direct native context+compute counters: sized CPU 4,995,104 / GPU 403,691,552 bytes; auto CPU 46,151,712 / GPU 5,052,291,104. Savings: CPU 41,156,608 / GPU 4,648,599,552 bytes. Model bytes identical and excluded. Actual aggregate allocation deltas match direct counters, remain stable after cold/warm, and return to model-only after context disposal. Metal unified-memory CPU/GPU classifications are allocation accounting, not independent physical memory pools; do not add RSS to these counters.

All six prepared inputs, full formatted token streams, unrounded native scores, public scores/ranks/indices match across arms and cold/warm calls. Changed score and truncated token controls reject. Batch 512, threads 6, flash auto, KV types 1 unchanged. Context creation: sized 102.43 ms, auto 343.78 ms. Native cold scoring: 323.01 vs 455.82 ms; warm: 256.78 vs 254.50 ms (sized slower by 2.28 ms). Whole calls: 919.09/260.80 vs 1300.62/258.83 ms. One ordered pair; no throughput, p99, or unbiased performance claim. Full unrounded values in analysis.json.

Predeclared new-host policy: normal pressure 1 at admission and throughout, minimum 128 GiB physical, kernel pressure-free statistic >=50%, Metal reported free capacity >=12 GiB, 180 seconds per isolated arm, 8192 MiB combined owned RSS. Warning/critical stops immediately. Metal capacity is not guaranteed physical free RAM; the policy combines independent pressure checks and retains native memory safety checks. Peak owned RSS sized 1473.75 MiB, auto 5831.30 MiB. All observed owned processes absent after each run; existing live GNO PID26032 identity unchanged. No unrelated process signalled or live config/index modified.

All attempts retained: v1 sized failed before Bun/product/native execution because mise shim resolution required the isolated HOME. V2 pins the actual same Bun 1.3.14 binary; sized and auto each executed once successfully, no native retries. Original helper/policy and failed raw stdout/stderr/resource receipt under raw-v1; corrected actual runs under raw-v2.

## Reproduction

Decompress each manifest payload to its source path in a new scratch root. Stage the exact npm archive, extract package, link existing compatible host dependencies, and verify package-pins shipped hashes. Update only scratch sourceRoot/output/model-location paths as needed, recording new location-dependent hashes. Keep exact fixture input and model SHA. Copy the declared helpers and run the hook tests with the pinned Bun. Native execution was:

```
cd /private/tmp/fn145-allocation-heimdall-f64.PC7xxc/v2
python3 supervise.py sized
python3 supervise.py auto
```

Auto refuses unless sized succeeded and all its owned process identities are absent. Use fresh arm directories; existing output is never overwritten. To reproduce analysis locally, unpack raw-v2 and helpers and run `python3 analyze.py`. `manifest.json` records original SHA/bytes and compressed SHA/bytes for every complete payload; gzip mtime is zero. SHA256SUMS covers all curated files except itself. No model, native binary, npm archive, private documents, or SQLite payload is included. No extra production/source acceptance is inferred from this allocation experiment.
