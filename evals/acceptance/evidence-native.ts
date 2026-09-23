// Bun has no directory creation or canonical-path API, nor path helpers.
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { EvidenceObservation } from "./evidence-schema";
import type { AcceptanceManifest } from "./manifest";

import { getModelsCachePath, buildUri } from "../../src/app/constants";
import { RETRIEVAL_TRACE_DEFAULT_RETENTION } from "../../src/config/retrieval-traces";
import { ConfigSchema, DEFAULT_MODEL_PRESETS } from "../../src/config/types";
import { ModelCache } from "../../src/llm/cache";
import { LlmAdapter } from "../../src/llm/nodeLlamaCpp/adapter";
import { createGnoClient } from "../../src/sdk/client";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { canonicalFingerprint } from "../agentic/canonical";
import { hashFile } from "./capture-contract";
import { evaluateEvidenceRun } from "./evidence";
import {
  capturedStages,
  capturedTokenizations,
  parseEvidenceReader,
  prepareEvidenceReader,
} from "./evidence-capture";
import { loadEvidenceFixtures } from "./evidence-fixtures";
import { captureSdkSearchResults } from "./native-adapter";
import { installParentCapture } from "./parent-capture";

const policy = { offline: true, allowDownload: false };
export const EVIDENCE_READER_PARAMS = {
  temperature: 0,
  maxTokens: 256,
  jsonSchema: {
    type: "object",
    properties: {
      values: { type: "array", items: { type: "string" } },
    },
    required: ["values"],
    additionalProperties: false,
  },
};

/** One bounded native screen, not a latency benchmark. All data and model
 * inputs are synthetic; existing indexes/services are never opened or stopped. */
export async function runNativeEvidenceScreen(outputDirectory: string) {
  if (
    !["cuda", "metal", "false"].includes(process.env.GNO_LLAMA_GPU ?? "") ||
    process.env.GNO_LLAMA_BUILD !== "never"
  )
    throw new Error(
      "Native screen requires GNO_LLAMA_GPU=cuda|metal|false (CPU) and GNO_LLAMA_BUILD=never"
    );
  const root = resolve(outputDirectory);
  await mkdir(root, { mode: 0o700 });
  if ((await realpath(root)) !== root)
    throw new Error("Use a canonical output directory");
  const { fixtures, sha256 } = await loadEvidenceFixtures();
  const preset = DEFAULT_MODEL_PRESETS[0]!;
  const cacheDir = getModelsCachePath();
  const cache = new ModelCache(cacheDir);
  const models: AcceptanceManifest["models"] = [];
  for (const [role, uri, type] of [
    ["embedding", preset.embed, "embed"],
    ["reranking", preset.rerank, "rerank"],
    ["generation", preset.expand!, "expand"],
    ["generation", preset.gen, "gen"],
  ] as const) {
    const path = await cache.resolve(uri, type);
    if (!path.ok) throw new Error(path.error.message);
    const hash = await hashFile(path.value);
    if (!models.some((m) => m.id === uri))
      models.push({ role, id: uri, sha256: hash, tokenizerSha256: hash });
  }
  const corpus = join(root, "corpus");
  for (const doc of fixtures.documents) {
    const relative = doc.uri.slice("gno://".length);
    const path = join(corpus, relative);
    await mkdir(resolve(path, ".."), { recursive: true });
    await Bun.write(path, doc.content);
  }
  const config = ConfigSchema.parse({
    version: "1.0",
    collections: ["notes", "private"].map((name) => ({
      name,
      path: join(corpus, name),
      pattern: "**/*.md",
    })),
    models: {
      activePreset: preset.id,
      loadTimeout: 120_000,
      inferenceTimeout: 120_000,
    },
    retrievalTraces: {
      enabled: true,
      redactionMode: "metadata",
      retention: RETRIEVAL_TRACE_DEFAULT_RETENTION,
    },
  });
  const captureDirectory = join(root, "capture");
  await mkdir(captureDirectory, { mode: 0o700 });
  const capture = await installParentCapture(
    crypto.randomUUID(),
    models,
    captureDirectory
  );
  const clients: Array<Awaited<ReturnType<typeof createGnoClient>>> = [];
  const restorers: Array<() => void> = [];
  const llm = new LlmAdapter(config, cacheDir);
  const observations: EvidenceObservation[] = [];
  const run = {
    schemaVersion: "gno-evidence-run-v1" as const,
    kind: "native" as const,
    observations,
  };
  try {
    for (const arm of ["current", "noExpand"]) {
      const directory = join(root, arm);
      await mkdir(directory, { mode: 0o700 });
      const client = await createGnoClient({
        config,
        indexName: `evidence-${arm}`,
        dbPath: join(directory, "index.sqlite"),
        cacheDir,
        downloadPolicy: policy,
      });
      clients.push(client);
      restorers.push(captureSdkSearchResults(client, capture.capture));
      await client.index({ batchSize: 1 });
    }
    const store = new SqliteAdapter();
    const opened = await store.open(
      join(root, "current", "index.sqlite"),
      config.ftsTokenizer
    );
    if (!opened.ok) throw new Error(opened.error.message);
    const documents = await store.listDocuments();
    if (!documents.ok) throw new Error(documents.error.message);
    const owners = new Map(
      documents.value.flatMap((d) =>
        d.mirrorHash
          ? [[d.mirrorHash, buildUri(d.collection, d.relPath)] as const]
          : []
      )
    );
    const chunkResult = await store.getChunksBatch([...owners.keys()]);
    await store.close();
    if (!chunkResult.ok) throw new Error(chunkResult.error.message);
    const port = await llm.createGenerationPort(preset.gen, {
      policy,
      egressCollections: ["notes"],
    });
    if (!port.ok) throw new Error(port.error.message);
    const commit = await Bun.$`git rev-parse HEAD`.text();
    const runtimeDirt =
      await Bun.$`git status --porcelain -- src vendor assets package.json bun.lock`.text();
    if (runtimeDirt.trim())
      throw new Error(
        "Native evidence requires unchanged committed runtime inputs"
      );
    const harnessHashes = Object.fromEntries(
      await Promise.all(
        [
          "evidence-native.ts",
          "evidence-capture.ts",
          "evidence.ts",
          "evidence-schema.ts",
          "evidence-fixtures.ts",
          "evidence-cli.ts",
        ].map(
          async (name) =>
            [
              name,
              await hashFile(Bun.fileURLToPath(new URL(name, import.meta.url))),
            ] as const
        )
      )
    );
    const identity = {
      harnessHashes,
      commit: commit.trim(),
      bun: Bun.version,
      models,
      config,
      fixtureSha256: sha256,
      readerParams: EVIDENCE_READER_PARAMS,
      retrievalOptions: {
        limit: 8,
        minScore: 0,
        explain: true,
        diagnoseTrace: true,
      },
      nativeDependencies: {
        nodeLlamaCpp: (
          await Bun.file(
            new URL(
              "../../node_modules/node-llama-cpp/package.json",
              import.meta.url
            )
          ).json()
        ).version,
        sqliteVec: (
          await Bun.file(
            new URL(
              "../../node_modules/sqlite-vec/package.json",
              import.meta.url
            )
          ).json()
        ).version,
      },
      platform: process.platform,
      architecture: process.arch,
      backend:
        process.env.GNO_LLAMA_GPU === "false"
          ? "cpu"
          : process.env.GNO_LLAMA_GPU,
      timingClaim:
        "single quality screen; concurrent host load; parent RSS only; no latency acceptance",
    };
    await Bun.write(
      join(root, "identity.json"),
      JSON.stringify(identity, null, 2)
    );
    for (const [index, item] of fixtures.cases.entries()) {
      for (const arm of index % 2
        ? (["noExpand", "current"] as const)
        : (["current", "noExpand"] as const)) {
        capture.begin(`${item.caseId}:${arm}`);
        capture.capture.modelInputs = [];
        capture.capture.modelOutputs = [];
        capture.capture.searchResults = [];
        capture.capture.errors = [];
        capture.capture.capabilities = [];
        capture.capture.contextEvents = [];
        const started = performance.now();
        const reasons: string[] = [];
        const client = clients[arm === "current" ? 0 : 1]!;
        const raw = await client.query(item.query, {
          collection: item.collection,
          limit: 8,
          minScore: 0,
          intent: item.intent ?? undefined,
          noExpand: arm === "noExpand",
          explain: true,
          diagnoseTrace: true,
        });
        const prepared = prepareEvidenceReader(fixtures, item, raw);
        if (prepared.unmappedSources) reasons.push("unmapped_delivery_source");
        const generated = await port.value.generate(
          prepared.prompt,
          EVIDENCE_READER_PARAMS
        );
        capture.finish();
        const receipt = structuredClone(capture.capture);
        if (!raw.meta.vectorsUsed || !raw.meta.reranked)
          reasons.push("native_retrieval_degraded");
        if (!receipt.backends.includes(process.env.GNO_LLAMA_GPU!))
          reasons.push("native_backend_unverified");
        for (const role of ["embedding", "reranking", "generation"])
          if (!receipt.modelInputs.some((m) => m.role === role))
            reasons.push(`model_not_exercised:${role}`);
        reasons.push(...receipt.errors);
        let reader: EvidenceObservation["reader"] = null;
        if (generated.ok) {
          try {
            reader = parseEvidenceReader(generated.value, item);
          } catch {
            reasons.push("reader_output_invalid");
          }
        } else reasons.push(`reader_failed:${generated.error.code}`);
        const observation: EvidenceObservation = {
          caseId: item.caseId,
          arm,
          noExpand: arm === "noExpand",
          fixtureSha256: sha256,
          identitySha256: canonicalFingerprint(identity),
          tokenBudget: item.tokenBudget,
          byteBudget: item.byteBudget,
          coverage: reasons.length ? "incomplete" : "complete",
          reasons,
          stages: {
            ...capturedStages(
              fixtures,
              raw,
              receipt,
              chunkResult.value,
              owners
            ),
            delivery: prepared.passages,
          },
          reader,
          cost: {
            visibleBytes: Buffer.byteLength(prepared.prompt),
            usedTokens: Buffer.byteLength(prepared.prompt),
            estimator: "unicode_conservative",
            readerOutputBytes: generated.ok
              ? Buffer.byteLength(generated.value)
              : null,
            readerOutputTokens: null,
            tokenizations: capturedTokenizations(receipt),
            durationMs: performance.now() - started,
            rssBytes: process.memoryUsage().rss,
          },
        };
        observations.push(observation);
        await Bun.write(
          join(root, `${item.caseId}-${arm}.json`),
          JSON.stringify(
            { raw, receipt, prompt: prepared.prompt, generated, observation },
            null,
            2
          )
        );
        await Bun.write(
          join(root, "observations.json"),
          JSON.stringify(run, null, 2)
        );
        console.error(`${item.caseId} ${arm}: ${observation.coverage}`);
      }
    }
    const report = evaluateEvidenceRun(fixtures, run, "native");
    await Bun.write(join(root, "report.json"), JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    await Bun.write(
      join(root, "failure.json"),
      JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        completedObservations: observations.length,
      })
    );
    throw error;
  } finally {
    try {
      for (const client of clients) await client.close();
      await llm.dispose();
    } finally {
      for (const restore of restorers) restore();
      capture.restore();
    }
  }
}
