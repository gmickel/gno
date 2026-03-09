# Export Contract

Sandbox output is not usable until it can be tested in local `gno`.

## Required Export Stages

1. adapter/artifact output from training
2. merged model directory
3. GGUF conversion
4. quantized runtime artifact
5. local `gno` benchmark run using `file:` URI

## Required Deliverables Per Export

- source config id
- base model
- training run id
- merged artifact path
- GGUF artifact path
- quantization
- exact `file:` URI used for `gno`
- benchmark output path

## Runtime Compatibility

The final artifact must be addressable as:

```text
file:/absolute/path/to/model.gguf
```

Expected local verification loop:

1. point a custom preset at the exported GGUF
2. run `bun run eval:retrieval-candidates`
3. compare against `evals/fixtures/retrieval-candidate-benchmark/latest.json`
