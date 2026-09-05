# Native lifecycle transport fixture

`native-lifecycle-v1` is a new synthetic fixture; no fn-143 goldens or historical
native receipts are replaced. `manifest.json` pins the runner bytes. The package
smoke helper checks that pin before execution and writes a receipt containing the
fixture hash and hashes of the tested package's client, entry, dispatcher,
protocol and ports. Full source-archive provenance remains the physical QA gate.

The real package-relative production entry handles metadata-only generation init
through three idle/restart cycles and is reaped on parent exit. No model weights
are loaded. A separate fault child uses the actual installed framing protocol and
client to exercise SIGKILL, pending-call failure, request IDs across restart,
9 MiB structured-generation request/response framing, exact decoded prompt and
schema/parameter equality, rejected 64 MiB embedding batches, and no automatic
replay. A nonresponsive child proves bounded forced disposal. Native diagnostic
stdout cannot pollute the runner's single JSON receipt.

`bun test ./test/llm/native-worker-integration.test.ts` packs with lifecycle scripts
disabled and reuses the checkout's installed dependencies by symlink. The full
`bun run test:package` gate also invokes this helper against its installed package
and drives the emitted MCP registration through stdio handshake/tool discovery.
Temporary logs and package artifacts remain outside the repository.

These are mechanical IPC and package-layout proofs. They do not establish native
inference parity, GPU reclamation, original Ivan 3/3 crash resolution, Ask crash
resolution, native CLI/MCP fault-result equality, or a fresh dependency installation
in the focused test. Those require the separate physical acceptance receipts.
