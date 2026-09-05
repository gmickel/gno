# Corrected helper8b45 attempt — scratch phase-hook failure

**Incomplete native acceptance.** The separately authorized helper8b45 stratum ran once using unchanged product a30/package592c3857 and the same declared inputs. Canonical signal capture passed its CPU checks, but this worker's scratch phase hook attempted to assign the native addon decodeBatch method, which is read-only. Native context setup consequently failed with 'Attempted to assign to readonly property.' This is an instrumentation defect, not evidence that cancellation is broken in the product.

All control/recovery fallback responses and direct-port errors are preserved. Queued and active cancellation are unexercised, not passes; no recovery parity claim. Pre-aborted public cancellation rejects, but does not establish the whole task. No retry occurred inside this run. Process exit0 is not a coverage pass. Observed PIDs366503/366549/366598 are all absent.

The prior helper9814 failure remains separately archived. A replacement JavaScript async-iterator observation hook requires CPU argument/protocol transparency proof and explicit host authorization before another named native stratum. It must not mutate native binding methods, pause evaluation or alter inputs.

Raw root: /home/gordon/.cache/agent-tmp/gno-fn146-native-cancellation-context-fixed. All full responses, child requests, phase and ownership events, resource logs, context CPU preflight, exact source/helper/driver pins and supervisor receipt are included; no database, cache, model, dependency tree or source archive. An initial overbroad CPU serialization probe applied model-input encoding to internal createContext defaults that only use telemetry encoding; its source is retained, and the corrected probe covers actual outer embedding model-input shapes plus inner context telemetry. This CPU correction did not run native inference.

Verify retained bytes with sha256sum -c SHA256SUMS. No task or native acceptance verdict.
