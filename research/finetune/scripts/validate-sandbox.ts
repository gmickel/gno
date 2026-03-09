#!/usr/bin/env bun
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020";
// node:path: Bun has no path join helpers.
import { join } from "node:path";

interface Manifest {
  split: "train" | "validation" | "heldout";
  caseCount: number;
  caseIds: string[];
}

const repoRoot = join(import.meta.dir, "../../..");
const sandboxDir = join(repoRoot, "research/finetune");
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);

async function loadJson(path: string): Promise<object> {
  return Bun.file(path).json();
}

async function validateJson(path: string, schemaPath: string): Promise<void> {
  const [json, schema] = await Promise.all([
    loadJson(path),
    loadJson(schemaPath),
  ]);
  const validate = ajv.compile(schema);
  if (!validate(json)) {
    throw new Error(
      `${path} failed schema validation: ${ajv.errorsText(validate.errors)}`
    );
  }
}

async function main(): Promise<void> {
  await validateJson(
    join(sandboxDir, "configs/expansion-qwen3-1.7b-sft.json"),
    join(sandboxDir, "schemas/expansion-sandbox-config.schema.json")
  );

  const promotionSchema = await loadJson(
    join(sandboxDir, "schemas/promotion-case.schema.json")
  );
  const validatePromotion = ajv.compile(promotionSchema);
  const promotionLines = (
    await Bun.file(
      join(sandboxDir, "data/promotion/promotion-cases.jsonl")
    ).text()
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  const cases = promotionLines.map((line, index) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (!validatePromotion(parsed)) {
      throw new Error(
        `promotion-cases.jsonl line ${index + 1} invalid: ${ajv.errorsText(validatePromotion.errors)}`
      );
    }
    return parsed as {
      id: string;
      split: "train" | "validation" | "heldout";
      caseSet: "baseline" | "adversarial" | "multilingual" | "ask";
    };
  });

  const manifests = await Promise.all(
    ["train", "validation", "heldout"].map(async (split) => {
      const path = join(sandboxDir, `data/splits/${split}.json`);
      return (await loadJson(path)) as Manifest;
    })
  );

  const seen = new Set<string>();
  for (const manifest of manifests) {
    if (manifest.caseIds.length !== manifest.caseCount) {
      throw new Error(`${manifest.split} manifest count mismatch`);
    }
    for (const id of manifest.caseIds) {
      if (seen.has(id)) {
        throw new Error(`split overlap detected for ${id}`);
      }
      seen.add(id);
    }
  }

  const heldoutIds = new Set(
    manifests.find((manifest) => manifest.split === "heldout")?.caseIds ?? []
  );
  const askIds = cases
    .filter((item) => item.caseSet === "ask")
    .map((item) => item.id);
  const multilingualIds = cases
    .filter((item) => item.caseSet === "multilingual")
    .map((item) => item.id);

  for (const id of [...askIds, ...multilingualIds]) {
    if (!heldoutIds.has(id)) {
      throw new Error(`heldout split missing required promotion case ${id}`);
    }
  }

  console.log(
    `Sandbox validation passed: ${cases.length} promotion cases, ${manifests.length} split manifests`
  );
}

await main();
