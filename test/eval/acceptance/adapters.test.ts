import { expect, test } from "bun:test";

import { ACCEPTANCE_SCHEMA_VERSION } from "../../../evals/acceptance/manifest";
import {
  projectAcceptance,
  replayAcceptance,
  type AdapterRequest,
} from "../../../evals/acceptance/native-adapter";
import {
  captureArguments,
  installNativeCapture,
  type NativeCapture,
} from "../../../evals/acceptance/native-capture";
import { ModelCache } from "../../../src/llm/cache";
import {
  SEARCH_RESULTS_TRACE_METADATA,
  type SearchResults,
} from "../../../src/pipeline/types";

const hash = "a".repeat(64);
const request: AdapterRequest = {
  manifest: {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    role: "baseline",
    identity: {
      commit: "a".repeat(40),
      indexId: "fixture",
      indexSha256: hash,
      bunVersion: Bun.version,
      nativeDependencies: {},
      platform: "linux",
      architecture: "x64",
    },
    fixtureVersion: "test",
    fixtures: [{ path: "test", sha256: hash }],
    models: ["embedding", "reranking", "generation"].map((role) => ({
      role: role as "embedding" | "reranking" | "generation",
      id: role,
      sha256: hash,
      tokenizerSha256: hash,
    })),
    cases: [
      {
        caseId: "one",
        fixtureSha256: hash,
        surface: "sdk",
        preset: "test",
        configuration: {},
      },
    ],
    intendedDeltas: [],
  },
  caseId: "one",
  query: "exact\r\nquery",
  operation: "hybrid",
  options: { noExpand: true },
  expectedBackend: "cuda",
};
const raw: SearchResults = {
  results: [
    {
      docid: "#aaaaaa",
      uri: "gno://test/a.md",
      score: 0.123456789,
      snippet: "do not use truncated snippet",
      snippetRange: { startLine: 1, endLine: 2 },
      source: { relPath: "a.md", mime: "text/markdown", ext: ".md" },
    },
  ],
  meta: {
    query: request.query,
    mode: "hybrid",
    totalResults: 1,
    vectorsUsed: true,
    reranked: true,
  },
  [SEARCH_RESULTS_TRACE_METADATA]: {
    capabilityOutcomes: [{ capability: "semantic_search", status: "used" }],
    fallbackCodes: [],
  },
};
function receipt(): NativeCapture {
  return {
    runId: "test",
    kind: "native",
    modelInputs: request.manifest.models.map((model) => ({
      role: model.role,
      modelId: model.id,
      input: captureArguments(["exact\r\nquery", ["tail\n", "中"]]),
    })),
    modelOutputs: [],
    backends: ["cuda"],
    models: request.manifest.models.map(({ id, sha256 }) => ({ id, sha256 })),
    capabilities: [],
    errors: [],
  };
}
const read = async () => ({ content: "exact\r\ntext\ntail", sourceHash: hash });

test("exact actual inputs, scores and selected evidence survive serialization", async () => {
  const result = await projectAcceptance(
    request,
    {
      ...raw,
      citations: [
        { docid: "#aaaaaa", uri: "gno://test/a.md", startLine: 1, endLine: 2 },
      ],
    },
    receipt(),
    read
  );
  expect(result.coverage).toBe("complete");
  const serialized = JSON.parse(JSON.stringify(result.record));
  expect(serialized.deterministic.modelInputs).toEqual(receipt().modelInputs);
  expect(serialized.deterministic.results[0].passage.text).toBe(
    "exact\r\ntext"
  );
  expect(serialized.deterministic.results[0].score).toBe(0.123456789);
  expect(serialized.deterministic.citations[0].text).toBe("exact\r\ntext");
  expect(serialized.deterministic.citations[0].sourceHash).toBe(hash);
  expect(captureArguments([[1, 2, 3]])).not.toEqual(
    captureArguments([[1, 2, 4]])
  );
  expect(captureArguments(["x", undefined])).not.toEqual(
    captureArguments(["x"])
  );
});

test.each([
  "missing-model",
  "missing-cuda",
  "missing-metal",
  "skipped-verification",
  "missing-vector-stage",
  "replay",
])("%s cannot yield native coverage", async (condition) => {
  const capture = receipt();
  const req = structuredClone(request);
  const output = { ...raw };
  if (condition === "missing-model") capture.models = [];
  if (condition === "missing-cuda") capture.backends = ["false"];
  if (condition === "missing-metal") req.expectedBackend = "metal";
  if (condition === "skipped-verification") req.operation = "verified-ask";
  if (condition === "missing-vector-stage")
    output[SEARCH_RESULTS_TRACE_METADATA] = undefined;
  if (condition === "replay") capture.kind = "replay";
  const result = await projectAcceptance(req, output, capture, read);
  expect(result.coverage).toBe("incomplete");
  expect(result.record.deterministic.semanticState.status).toBe("incomplete");
});

test("replay remains a separate non-native receipt", async () => {
  const result = await projectAcceptance(request, raw, receipt(), read);
  const replay = replayAcceptance(result);
  expect(replay.receipt.kind).toBe("replay");
  expect(replay.coverage).toBe("incomplete");
  expect(result.coverage).toBe("complete");
});

test("capture forbids overlap and restores native prototypes after missing cached model", async () => {
  const original = ModelCache.prototype.ensureModel;
  const session = installNativeCapture("missing", [
    {
      role: "embedding",
      id: "file:/nonexistent/gno-acceptance.gguf",
      sha256: hash,
      tokenizerSha256: hash,
    },
  ]);
  try {
    expect(() => installNativeCapture("overlap", [])).toThrow("already active");
    const result = await new ModelCache(
      "/nonexistent/gno-acceptance-cache"
    ).ensureModel("file:/nonexistent/gno-acceptance.gguf", "embed", {
      offline: false,
      allowDownload: true,
    });
    expect(result.ok).toBe(false);
    expect(session.capture.errors.length).toBe(1);
  } finally {
    session.restore();
  }
  expect(ModelCache.prototype.ensureModel).toBe(original);
  const next = installNativeCapture("next", []);
  next.restore();
});

test("owned CLI output cannot turn uninstrumented vectorsUsed into native coverage", async () => {
  // Bun has no directory creation/removal API.
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { runSurfaceAcceptance } =
    await import("../../../evals/acceptance/surface-adapter");
  const root = await mkdtemp("/tmp/gno-acceptance-cli-");
  const req = structuredClone(request);
  req.manifest.cases[0]!.surface = "cli";
  try {
    const result = await runSurfaceAcceptance(
      req,
      {
        cwd: process.cwd(),
        args: ["--eval", `console.log(${JSON.stringify(JSON.stringify(raw))})`],
        env: { GNO_CONFIG_DIR: root, GNO_DATA_DIR: root, GNO_CACHE_DIR: root },
        capturePath: `${root}/capture.json`,
        timeoutMs: 10000,
      },
      { surface: "cli" },
      read
    );
    expect(result.coverage).toBe("incomplete");
    expect(result.receipt.modelInputs).toEqual([]);
    expect(result.reasons).toContain("model_not_exercised:embedding");
    expect(result.record.deterministic.semanticState.vectorsUsed).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
