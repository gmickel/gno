import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GenerationPort } from "../../src/llm/types";
import type { AskResult } from "../../src/pipeline/types";

import { runCli } from "../../src/cli/run";
import { LlmAdapter } from "../../src/llm/nodeLlamaCpp/adapter";
import { safeRm } from "../helpers/cleanup";

const generationPort = (): GenerationPort => ({
  modelUri: "file:/verified-cli.gguf",
  structuredOutput: "json_schema",
  generate: async (_prompt, params) => {
    if (!params?.jsonSchema) {
      return { ok: true, value: "Mina owns the launch decision [1]." };
    }
    const properties = (
      params.jsonSchema as {
        properties: {
          judgments: {
            items: {
              properties: {
                claimId: { enum: string[] };
                evidenceIds: { items: { enum: string[] } };
              };
            };
          };
        };
      }
    ).properties.judgments.items.properties;
    return {
      ok: true,
      value: JSON.stringify({
        judgments: [
          {
            claimId: properties.claimId.enum[0],
            verdict: "supported",
            confidence: 1,
            evidenceIds: [properties.evidenceIds.items.enum[0]],
            rationaleCode: "semantic_entailment",
          },
        ],
        unresolvedClaimIds: [],
      }),
    };
  },
  dispose: async () => {},
});

describe("gno ask --verify", () => {
  let root = "";
  let stdout = "";
  let stderr = "";
  let originalStdout: typeof process.stdout.write;
  let originalStderr: typeof process.stderr.write;
  const originalEnv = {
    configDir: process.env.GNO_CONFIG_DIR,
    dataDir: process.env.GNO_DATA_DIR,
    cacheDir: process.env.GNO_CACHE_DIR,
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-cli-verified-ask-"));
    const corpus = join(root, "corpus");
    await Bun.write(
      join(corpus, "decision.md"),
      "# Owner\nMina owns the launch decision."
    );
    process.env.GNO_CONFIG_DIR = join(root, "config");
    process.env.GNO_DATA_DIR = join(root, "data");
    process.env.GNO_CACHE_DIR = join(root, "cache");
    originalStdout = process.stdout.write.bind(process.stdout);
    originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    expect(
      await runCli(["bun", "gno", "init", corpus, "--name", "notes"])
    ).toBe(0);
    stdout = "";
    stderr = "";
    expect(await runCli(["bun", "gno", "update"])).toBe(0);
    stdout = "";
    stderr = "";
  });

  afterEach(async () => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.env.GNO_CONFIG_DIR = originalEnv.configDir;
    process.env.GNO_DATA_DIR = originalEnv.dataDir;
    process.env.GNO_CACHE_DIR = originalEnv.cacheDir;
    await safeRm(root);
  });

  test("executes the explicit flag and leaves raw Ask compatible", async () => {
    const unavailable = async () => ({
      ok: false as const,
      error: {
        code: "MODEL_NOT_CACHED" as const,
        message: "disabled in CLI test",
        retryable: false,
      },
    });
    const embedSpy = spyOn(
      LlmAdapter.prototype,
      "createEmbeddingPort"
    ).mockImplementation(unavailable);
    const rerankSpy = spyOn(
      LlmAdapter.prototype,
      "createRerankPort"
    ).mockImplementation(unavailable);
    const generationSpy = spyOn(
      LlmAdapter.prototype,
      "createGenerationPort"
    ).mockImplementation(async () => ({
      ok: true,
      value: generationPort(),
    }));
    try {
      const verifiedCode = await runCli([
        "bun",
        "gno",
        "ask",
        "Mina",
        "--verify",
        "--fast",
        "--json",
      ]);
      if (verifiedCode !== 0) {
        throw new Error(stderr);
      }
      const verified = JSON.parse(stdout) as AskResult;
      expect(verified.verification).toMatchObject({
        mode: "closed_capsule",
        claims: { answerStatus: "verified", abstained: false },
      });
      expect(verified.verification?.capsule.scope.indexName).toBe("default");

      stdout = "";
      stderr = "";
      expect(
        await runCli([
          "bun",
          "gno",
          "ask",
          "Mina",
          "--no-answer",
          "--fast",
          "--json",
        ])
      ).toBe(0);
      const raw = JSON.parse(stdout) as AskResult;
      expect(raw.verification).toBeUndefined();
      expect(raw.results.length).toBeGreaterThan(0);
    } finally {
      embedSpy.mockRestore();
      rerankSpy.mockRestore();
      generationSpy.mockRestore();
    }
  });
});
