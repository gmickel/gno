#!/usr/bin/env bun
import { join } from "node:path";

import { createDefaultConfig } from "../../../src/config";
import { LlmAdapter } from "../../../src/llm/nodeLlamaCpp/adapter";
import { expandQuery } from "../../../src/pipeline/expansion";

const modelPath = join(
  import.meta.dir,
  "../outputs/mlx-smoke-fused-deq/gno-expansion-qwen3-1.7b-smoke-f16.gguf"
);

const queries = [
  "ECONNREFUSED 127.0.0.1:5432",
  '"Authorization: Bearer" token endpoint',
];

const llm = new LlmAdapter(createDefaultConfig());
const genResult = await llm.createGenerationPort(`file:${modelPath}`);
if (!genResult.ok) {
  throw new Error(genResult.error.message);
}

try {
  for (const query of queries) {
    const rawPrompt =
      "/no_think Expand this search query for GNO hybrid retrieval.\n" +
      `Query: "${query}"\n` +
      "Respond with valid JSON only.";
    const rawResult = await genResult.value.generate(rawPrompt, {
      temperature: 0,
      seed: 42,
      maxTokens: 256,
      contextSize: 2048,
    });
    const result = await expandQuery(genResult.value, query, {
      contextSize: 2048,
    });
    console.log(
      JSON.stringify(
        {
          query,
          ok: result.ok,
          raw: rawResult.ok ? rawResult.value : null,
          parsed: result.ok ? result.value : null,
        },
        null,
        2
      )
    );
  }
} finally {
  await genResult.value.dispose();
  await llm.dispose();
}
