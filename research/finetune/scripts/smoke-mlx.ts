#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { parseExpansionOutput } from "../../../src/pipeline/expansion";

const model = "mlx-community/Qwen3-1.7B-4bit";
const adapterPath = join(
  import.meta.dir,
  "../outputs/mlx-qwen3-1.7b-lora/adapters"
);

const cases = [
  "ECONNREFUSED 127.0.0.1:5432",
  '"Authorization: Bearer" token endpoint',
  'connection timeout -"ECONNREFUSED"',
];

for (const query of cases) {
  const result = spawnSync(
    "python3",
    [
      "-m",
      "mlx_lm",
      "generate",
      "--model",
      model,
      "--adapter-path",
      adapterPath,
      "--prompt",
      `/no_think Expand this search query for GNO hybrid retrieval.\nQuery: "${query}"\nRespond with valid JSON only.`,
      "--max-tokens",
      "256",
      "--temp",
      "0",
      "--top-p",
      "1.0",
      "--verbose",
      "false",
    ],
    {
      cwd: join(import.meta.dir, "../../.."),
      encoding: "utf8",
    }
  );

  const output = result.stdout.trim();
  const parsed = parseExpansionOutput(output, query);
  console.log(
    JSON.stringify(
      {
        query,
        ok: result.status === 0,
        parseOk: parsed !== null,
        output,
      },
      null,
      2
    )
  );
}
