# 2026-03-09 MLX Calibration

Purpose:

- prove local MLX LoRA path works end-to-end on this machine
- measure throughput/memory for sizing the first real run

Config:

- model: `mlx-community/Qwen3-1.7B-4bit`
- data: `research/finetune/data/mlx`
- examples: `1984` total (`1785` train / `199` valid)
- layers tuned: `8`
- iters: `100`
- batch size: `1`
- grad accumulation: `4`
- max seq length: `1024`
- learning rate: `1e-5`

Observed:

- trainable params: `4.981M` (`0.289%`)
- peak memory: `2.236 GB`
- initial val loss: `5.828`
- best observed val loss during run: `1.061` at iter `80`
- final val loss: `1.187`
- steady-state training throughput:
  - roughly `7-9 it/s`
  - roughly `1.6k-1.9k tokens/s`

Outcome:

- local MLX LoRA training path works on this machine
- no runtime or memory issues at calibration settings
- next step should be a real run with:
  - `iters: 1000-3000`
  - `num_layers: 8-16`
  - `max_seq_length: 1024-2048`

Follow-on portable path already proven separately:

- fuse with `--dequantize`
- convert fused model to GGUF with `llama.cpp`
- load GGUF through `gno`
