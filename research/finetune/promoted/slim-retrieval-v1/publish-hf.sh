#!/usr/bin/env bash
set -euo pipefail

REPO_ID="guiltylemon/gno-expansion-slim-retrieval-v1"
GGUF_PATH="/Users/gordon/work/gno/research/finetune/outputs/auto-entity-lock-default-mix-lr95-best-fused-deq/gno-expansion-auto-entity-lock-default-mix-lr95-f16.gguf"
STAGE_DIR="/Users/gordon/work/gno/research/finetune/promoted/slim-retrieval-v1/hf"

hf repos create "$REPO_ID" --type model --exist-ok
hf upload "$REPO_ID" "$STAGE_DIR/README.md" README.md --commit-message "docs: update model card"
hf upload "$REPO_ID" "$STAGE_DIR/install-snippet.yaml" install-snippet.yaml --commit-message "docs: add install snippet"
hf upload "$REPO_ID" "$STAGE_DIR/release-manifest.json" release-manifest.json --commit-message "docs: add release manifest"
hf upload "$REPO_ID" "$STAGE_DIR/benchmark-summary.json" benchmark-summary.json --commit-message "docs: add benchmark summary"
hf upload "$REPO_ID" "$STAGE_DIR/repeat-benchmark.json" repeat-benchmark.json --commit-message "docs: add repeated benchmark"
hf upload "$REPO_ID" "$STAGE_DIR/promotion-summary.json" promotion-summary.json --commit-message "docs: add promotion summary"
hf upload "$REPO_ID" "$STAGE_DIR/promotion-target-check.json" promotion-target-check.json --commit-message "docs: add promotion target check"
hf upload "$REPO_ID" "$STAGE_DIR/confirmed-incumbent.json" confirmed-incumbent.json --commit-message "docs: add incumbent confirmation"
hf upload "$REPO_ID" "$GGUF_PATH" "gno-expansion-auto-entity-lock-default-mix-lr95-f16.gguf" --commit-message "model: upload promoted GGUF"
