# fn-77-future-onnx-and-transformersjs-runtime.1 Evaluate ONNX and Transformers.js runtime path

## Description

Run a focused research spike on whether ONNX/Transformers.js should become a supported GNO runtime path for embeddings or model deployment.

Use QMD's ONNX conversion direction as inspiration only. Compare against GNO's current GGUF/node-llama-cpp and HTTP adapter story. The result may be a rejection, a future implementation plan, or a small experimental adapter plan.

## Acceptance

- [ ] Identify current candidate packages/tooling for Transformers.js ONNX inference and conversion, using current upstream docs/release state.
- [ ] Compare install size, platform support, runtime performance, and packaging complexity with existing GGUF/node-llama-cpp.
- [ ] Test or prototype enough to measure at least one embedding model path on a small fixture, if feasible.
- [ ] Decide likely target surface: CLI, desktop, browser/Web UI, fine-tune export utility, or none.
- [ ] Record risks around model compatibility, SIMD/WebGPU availability, offline use, and npm package size.
- [ ] If follow-up implementation is justified, create a concrete implementation epic/task split instead of implementing broad runtime changes inside this spike.
- [ ] Update docs or notes only if the decision changes recommended model/export guidance.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
