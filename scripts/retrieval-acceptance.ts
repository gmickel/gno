/** Development-only paired acceptance; never registered in the public CLI. */
// Bun has no realpath/stat filesystem identity APIs or path utilities.
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

import type { AdapterRequest } from "../evals/acceptance/native-adapter";

import { compareAcceptance } from "../evals/acceptance/compare";
import { validateManifestPair } from "../evals/acceptance/manifest";
import { runPairedAcceptance } from "../evals/acceptance/runner";
import { createSessionDriverFactory } from "../evals/acceptance/session-driver";
import { canonicalJson } from "../evals/agentic/canonical";
import { ConfigSchema } from "../src/config/types";
import { assertPackageSmokePathContained } from "./package-smoke-isolation";
import { verifyAcceptanceSource } from "./retrieval-acceptance-source";

const pathSchema = z.string().refine(isAbsolute, "Use an absolute path");
const common = {
  baselineManifest: pathSchema,
  candidateManifest: pathSchema,
  output: pathSchema,
};
const sideSchema = z.strictObject({
  sourceRoot: pathSchema,
  isolatedRoot: pathSchema,
  protocolRoot: pathSchema,
  configPath: pathSchema,
  dbPath: pathSchema,
  cacheDir: pathSchema,
  cudaPath: pathSchema.optional(),
  sourceArchive: z
    .strictObject({
      path: pathSchema,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});
const requestSchema = z.strictObject({
  caseId: z.string().min(1),
  query: z.string().min(1),
  operation: z.enum(["hybrid", "verified-ask"]),
  options: z.record(z.string(), z.json()),
  expectedBackend: z.enum(["cuda", "metal"]),
});
export const acceptanceCommandSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    ...common,
    mode: z.literal("compare"),
    baselineRecords: pathSchema,
    candidateRecords: pathSchema,
  }),
  z.strictObject({
    ...common,
    mode: z.literal("native"),
    fixtureRoot: pathSchema,
    baseline: sideSchema,
    candidate: sideSchema,
    requests: z.array(requestSchema).min(1),
    seed: z.number().int().nonnegative(),
    observations: z.number().int().positive().default(30),
    strata: z
      .array(
        z.enum(["fresh-process", "resident-model-cold", "warm", "post-idle"])
      )
      .min(1),
    order: z.enum(["alternating", "randomized"]).default("alternating"),
    idleMs: z.number().nonnegative().default(1000),
    timeoutMs: z.number().positive().default(120000),
    sampleGpu: z.boolean().default(false),
    hostLoadCaveats: z.array(z.string()).default([]),
  }),
]);

export function parseAcceptanceArgs(args: string[]) {
  if (args.length === 1 && args[0] === "--help") return null;
  const native = args.includes("--native");
  const rest = args.filter((arg) => arg !== "--native");
  if (
    rest.length !== 2 ||
    rest[0] !== "--config" ||
    !rest[1] ||
    args.filter((arg) => arg === "--native").length > 1
  )
    throw new Error(
      "Usage: bun run eval:acceptance --config /absolute/run.json [--native]"
    );
  return { configPath: pathSchema.parse(rest[1]), native };
}

async function sha256(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const bytes of Bun.file(path).stream()) hash.update(bytes);
  return hash.digest("hex");
}

export async function runAcceptanceCommand(args: string[]): Promise<number> {
  const parsed = parseAcceptanceArgs(args);
  if (!parsed) {
    console.log(
      "bun run eval:acceptance --config /absolute/run.json [--native]\nSee evals/README.md. compare = deterministic records only; native = retained SDK paired screen."
    );
    return 0;
  }
  const config = acceptanceCommandSchema.parse(
    await Bun.file(parsed.configPath).json()
  );
  if (config.mode === "native" && !parsed.native)
    throw new Error("Native acceptance requires explicit --native opt-in");
  if (config.mode === "compare" && parsed.native)
    throw new Error("--native requires mode native");
  const pair = validateManifestPair(
    await Bun.file(config.baselineManifest).json(),
    await Bun.file(config.candidateManifest).json()
  );
  if (await Bun.file(config.output).exists())
    throw new Error("Output already exists; select a new receipt path");
  if (config.mode === "compare") {
    const records = z.array(z.unknown());
    const comparison = compareAcceptance(
      pair.baseline,
      pair.candidate,
      records.parse(await Bun.file(config.baselineRecords).json()),
      records.parse(await Bun.file(config.candidateRecords).json())
    );
    await Bun.write(
      config.output,
      JSON.stringify(
        { mode: "compare", nativeCoverage: "not-run", ...comparison },
        null,
        2
      )
    );
    console.log(
      JSON.stringify({
        output: config.output,
        passed: comparison.passed,
        nativeCoverage: "not-run",
      })
    );
    return comparison.passed ? 0 : 1;
  }
  if (new Set(config.strata).size !== config.strata.length)
    throw new Error("Duplicate latency state");
  if (
    (config.baseline.cudaPath || config.candidate.cudaPath) &&
    config.requests.some((request) => request.expectedBackend !== "cuda")
  )
    throw new Error("cudaPath is valid only for CUDA requests");
  const expected = pair.baseline.cases.map((item) => item.caseId).toSorted();
  if (
    JSON.stringify(config.requests.map((item) => item.caseId).toSorted()) !==
    JSON.stringify(expected)
  )
    throw new Error("Requests must cover each manifest case exactly once");
  for (const entry of pair.baseline.cases) {
    if (entry.surface !== "sdk")
      throw new Error(
        "Retained native runner supports SDK cases only; CLI/MCP/API require separate captured surface QA"
      );
    const request = config.requests.find(
      (item) => item.caseId === entry.caseId
    )!;
    const { caseId: _caseId, ...input } = request;
    if (
      canonicalJson(entry.configuration.request ?? null) !==
      canonicalJson(input)
    )
      throw new Error(`Pinned request mismatch: ${entry.caseId}`);
  }
  for (const fixture of pair.baseline.fixtures) {
    const path = join(config.fixtureRoot, fixture.path);
    await assertPackageSmokePathContained(
      config.fixtureRoot,
      path,
      "acceptance fixture"
    );
    if ((await sha256(path)) !== fixture.sha256)
      throw new Error(`Fixture hash mismatch: ${fixture.path}`);
  }
  const identities = await Promise.all([
    stat(config.baseline.dbPath),
    stat(config.candidate.dbPath),
  ]);
  if (
    identities[0].dev === identities[1].dev &&
    identities[0].ino === identities[1].ino
  )
    throw new Error(
      "Baseline and candidate require independent physical indexes"
    );
  const prepared = await Promise.all(
    (["baseline", "candidate"] as const).map(async (side) => {
      const settings = config[side];
      const manifest = pair[side];
      await assertPackageSmokePathContained(
        settings.isolatedRoot,
        settings.dbPath,
        "acceptance index"
      );
      if ((await sha256(settings.dbPath)) !== manifest.identity.indexSha256)
        throw new Error(`${side}: index hash mismatch`);
      if (
        manifest.identity.bunVersion !== Bun.version ||
        manifest.identity.platform !== process.platform ||
        manifest.identity.architecture !== process.arch
      )
        throw new Error(`${side}: runtime/platform identity mismatch`);
      const { sourceRoot, dirtyStatus } = await verifyAcceptanceSource(
        settings,
        manifest.identity.commit
      );
      for (const [name, version] of Object.entries(
        manifest.identity.nativeDependencies
      )) {
        const dependency = await Bun.file(
          join(sourceRoot, "node_modules", name, "package.json")
        ).json();
        if (dependency.version !== version)
          throw new Error(`${side}: dependency version mismatch: ${name}`);
      }
      const productConfig = ConfigSchema.parse(
        await Bun.file(settings.configPath).json()
      );
      for (const collection of productConfig.collections)
        await assertPackageSmokePathContained(
          settings.isolatedRoot,
          collection.path,
          "acceptance corpus"
        );
      await assertPackageSmokePathContained(
        settings.isolatedRoot,
        settings.protocolRoot,
        "acceptance protocol"
      );
      const requests: AdapterRequest[] = config.requests.map((request) => ({
        ...request,
        manifest,
      }));
      return {
        side,
        sourceRoot,
        dirtyStatus,
        factory: createSessionDriverFactory({
          ...settings,
          sourceRoot,
          manifest,
          requests,
          timeoutMs: config.timeoutMs,
          init: {
            config: productConfig,
            dbPath: settings.dbPath,
            cacheDir: settings.cacheDir,
          },
        }),
      };
    })
  );
  const [baseline, candidate] = prepared;
  const report = await runPairedAcceptance({
    ...pair,
    factories: { baseline: baseline!.factory, candidate: candidate!.factory },
    seed: config.seed,
    strata: config.strata,
    observations: config.observations,
    order: config.order,
    idleMs: config.idleMs,
    timeoutMs: config.timeoutMs,
    sampleGpu: config.sampleGpu,
    hostLoadCaveats: config.hostLoadCaveats,
  });
  await Bun.write(
    config.output,
    JSON.stringify(
      {
        ...report,
        command: {
          config,
          sources: prepared.map(({ side, sourceRoot, dirtyStatus }) => ({
            side,
            sourceRoot,
            dirtyStatus,
          })),
        },
      },
      null,
      2
    )
  );
  console.log(JSON.stringify({ output: config.output, status: report.status }));
  return report.status === "screened" ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await runAcceptanceCommand(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
