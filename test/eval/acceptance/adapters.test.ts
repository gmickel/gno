import { expect, test } from "bun:test";

import { compareAcceptance } from "../../../evals/acceptance/compare";
import { ACCEPTANCE_SCHEMA_VERSION } from "../../../evals/acceptance/manifest";
import {
  projectAcceptance,
  captureSdkSearchResults,
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

test.each([
  "declared",
  "undeclared-expansion",
  "undeclared-graph",
  "wrong-reason",
  "failed-stage",
  "required-embedding",
  "required-reranking",
] as const)("optional-stage classification: %s", async (scenario) => {
  const req = {
    ...request,
    options: { noExpand: true, graph: false, noRerank: false },
  };
  const trace: NonNullable<
    SearchResults[typeof SEARCH_RESULTS_TRACE_METADATA]
  > = {
    capabilityOutcomes: [
      { capability: "semantic_search", status: "used" },
      {
        capability: "query_expansion",
        status: "unavailable",
        reasonCode: "expansion_disabled",
      },
      {
        capability: "graph_expansion",
        status: "unavailable",
        reasonCode: "graph_disabled",
      },
    ],
    fallbackCodes: ["expansion_disabled", "graph_disabled"],
  };
  if (scenario === "undeclared-expansion") req.options.noExpand = false;
  if (scenario === "undeclared-graph") req.options.graph = true;
  if (scenario === "wrong-reason")
    trace.capabilityOutcomes[1]!.reasonCode = "expansion_error";
  if (scenario === "failed-stage")
    trace.capabilityOutcomes[1]!.status = "failed";
  const captured = receipt();
  if (scenario === "required-embedding" || scenario === "required-reranking") {
    const role = scenario === "required-embedding" ? "embedding" : "reranking";
    captured.modelInputs = captured.modelInputs.filter(
      (input) => input.role !== role
    );
    trace.capabilityOutcomes.push({
      capability: role === "embedding" ? "semantic_search" : "reranking",
      status: "unavailable",
      reasonCode:
        role === "embedding" ? "vector_unavailable" : "rerank_disabled",
    });
    if (role === "reranking") req.options.noRerank = true;
  }
  captured.capabilities = structuredClone(trace.capabilityOutcomes);
  const originalCapabilities = structuredClone(captured.capabilities);
  const output = { ...raw, [SEARCH_RESULTS_TRACE_METADATA]: trace };
  const projected = await projectAcceptance(req, output, captured, read);
  expect(projected.coverage).toBe(
    scenario === "declared" ? "complete" : "incomplete"
  );
  expect(projected.receipt.capabilities).toEqual(originalCapabilities);
  expect(projected.raw).toBe(output);
  if (scenario === "declared")
    expect(projected.record.deterministic.semanticState.fallbacks).toEqual([]);
});

test.each([
  "pinned",
  "default",
  "unpinned",
  "failed",
  "wrong-reason",
  "missing-embedding",
  "missing-vector",
] as const)("embedding-only native coverage: %s", async (scenario) => {
  const req = structuredClone(request);
  req.options.noRerank = true;
  req.manifest.cases[0]!.configuration.options = {
    noExpand: true,
    noRerank: true,
  };
  if (scenario === "default") delete req.options.noRerank;
  if (scenario === "unpinned")
    req.manifest.cases[0]!.configuration.options = {};
  const captured = receipt();
  captured.modelInputs = captured.modelInputs.filter(
    (input) => input.role === "embedding"
  );
  const trace: NonNullable<
    SearchResults[typeof SEARCH_RESULTS_TRACE_METADATA]
  > = {
    capabilityOutcomes: [
      { capability: "semantic_search", status: "used" },
      {
        capability: "reranking",
        status: "unavailable",
        reasonCode: "rerank_disabled",
      },
    ],
    fallbackCodes: ["rerank_disabled"],
  };
  if (scenario === "failed") trace.capabilityOutcomes[1]!.status = "failed";
  if (scenario === "wrong-reason")
    trace.capabilityOutcomes[1]!.reasonCode = "rerank_error";
  if (scenario === "missing-embedding") captured.modelInputs = [];
  if (scenario === "missing-vector")
    trace.capabilityOutcomes[0]!.status = "unavailable";
  captured.capabilities = structuredClone(trace.capabilityOutcomes);
  const result = await projectAcceptance(
    req,
    {
      ...raw,
      meta: { ...raw.meta, reranked: false },
      [SEARCH_RESULTS_TRACE_METADATA]: trace,
    },
    captured,
    read
  );
  expect(result.coverage).toBe(
    scenario === "pinned" ? "complete" : "incomplete"
  );
  expect(result.receipt.capabilities).toEqual(trace.capabilityOutcomes);
  if (scenario === "pinned") {
    expect(
      result.record.deterministic.modelInputs.every(
        (input) => input.role === "embedding"
      )
    ).toBe(true);
    expect(result.record.deterministic.semanticState.vectorStatus).toBe("used");
  }
});

test.each(["timing", "verdict", "citation"] as const)(
  "verification %s parity preserves semantic evidence",
  async (change) => {
    const baselineRequest = { ...request, operation: "verified-ask" as const };
    const candidateRequest = structuredClone(baselineRequest);
    candidateRequest.manifest.role = "candidate";
    candidateRequest.manifest.identity.indexId = "candidate";
    const baselineRaw = {
      ...raw,
      citations: [
        { docid: "#aaaaaa", uri: "gno://test/a.md", startLine: 1, endLine: 2 },
      ],
      verification: {
        semantic: {
          status: "completed",
          reason: "verified",
          schemaRequested: true,
          schemaEnforced: true,
          modelFingerprint: hash,
          configFingerprint: hash,
          verifierFingerprint: hash,
          candidateClaims: 1,
          verifiedClaims: 1,
          unresolvedClaims: 0,
          modelCalls: 1,
          durationMs: 12.125,
        },
        claims: {
          answerStatus: "verified",
          claims: [
            { verdict: "supported", text: "Exact claim", evidenceIds: [hash] },
          ],
        },
        capsule: {
          evidence: [
            {
              sourceHash: hash,
              observedAt: "2026-09-05T00:00:00Z",
              provenance: { durationMs: 7 },
            },
          ],
        },
      },
    };
    const candidateRaw = {
      ...baselineRaw,
      citations: structuredClone(baselineRaw.citations),
      verification: structuredClone(baselineRaw.verification),
    };
    candidateRaw.verification.semantic.durationMs = 87.75;
    if (change === "verdict")
      candidateRaw.verification.claims.claims[0]!.verdict = "contradicted";
    if (change === "citation") candidateRaw.citations[0]!.endLine = 3;
    const baseline = await projectAcceptance(
      baselineRequest,
      baselineRaw,
      receipt(),
      read
    );
    const candidate = await projectAcceptance(
      candidateRequest,
      candidateRaw,
      receipt(),
      read
    );
    const compared = compareAcceptance(
      baselineRequest.manifest,
      candidateRequest.manifest,
      [baseline.record],
      [candidate.record]
    );
    expect(compared.passed).toBe(change === "timing");
    expect(baseline.record.transport.verificationSemanticDurationMs).toBe(
      12.125
    );
    expect(candidate.record.transport.verificationSemanticDurationMs).toBe(
      87.75
    );
    expect(baseline.raw).toBe(baselineRaw);
    expect(baselineRaw.verification.semantic.durationMs).toBe(12.125);
    const { durationMs: _timing, ...semantic } =
      baselineRaw.verification.semantic;
    expect(baseline.record.deterministic.semanticState.verification).toEqual({
      ...baselineRaw.verification,
      semantic,
    });
  }
);

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
  // Bun has no platform temporary-directory utility.
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(`${tmpdir()}/gno-acceptance-cli-`);
  const req = structuredClone(request);
  req.manifest.cases[0]!.surface = "cli";
  try {
    const result = await runSurfaceAcceptance(
      req,
      {
        cwd: process.cwd(),
        isolatedRoot: root,
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

test.each(["used", "false-vector", "fallback", "missing-trace"] as const)(
  "SDK decoration captures actual hidden outcomes with tracing off: %s",
  async (scenario) => {
    const capture = receipt();
    const incoming = structuredClone(raw);
    const trace = structuredClone(raw[SEARCH_RESULTS_TRACE_METADATA]!);
    if (scenario === "false-vector") incoming.meta.vectorsUsed = false;
    if (scenario === "fallback") {
      trace.capabilityOutcomes.push({
        capability: "query_expansion",
        status: "failed",
        reasonCode: "expansion_timeout",
      });
      trace.fallbackCodes.push("expansion_timeout");
    }
    if (scenario !== "missing-trace")
      Object.defineProperty(incoming, SEARCH_RESULTS_TRACE_METADATA, {
        value: trace,
        enumerable: false,
      });
    class SelectedClient {
      decorateSearchResults(result: SearchResults): SearchResults {
        return {
          ...result,
          results: result.results.map((item) => ({ ...item })),
        };
      }
    }
    const client = new SelectedClient();
    const original = client.decorateSearchResults;
    const restore = captureSdkSearchResults(client, capture);
    const output = client.decorateSearchResults(incoming);
    expect(output[SEARCH_RESULTS_TRACE_METADATA]).toBeUndefined();
    expect(output.meta).toBe(incoming.meta);
    expect(capture.capabilities).toEqual([]);
    expect(capture.searchResults?.[0]).toEqual({
      source: "src/sdk/client.ts",
      method: "decorateSearchResults",
      result: structuredClone(incoming),
      trace: scenario === "missing-trace" ? null : trace,
    });
    const projected = await projectAcceptance(request, output, capture, read);
    expect(projected.coverage).toBe(
      scenario === "used" ? "complete" : "incomplete"
    );
    if (scenario === "fallback")
      expect(projected.reasons).toContain("native_fallback");
    restore();
    expect(client.decorateSearchResults).toBe(original);
    expect(Object.hasOwn(client, "decorateSearchResults")).toBe(false);
    expect(() => captureSdkSearchResults({}, capture)).toThrow(
      "Unsupported SDK"
    );
  }
);
