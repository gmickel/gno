import { expect, test } from "bun:test";

import { compareAcceptance } from "../../../evals/acceptance/compare";
import {
  ACCEPTANCE_SCHEMA_VERSION,
  acceptanceManifestFingerprint,
  freezeAcceptanceManifest,
  type AcceptanceManifest,
} from "../../../evals/acceptance/manifest";
import {
  deterministicRecordFingerprint,
  type AcceptanceRecord,
} from "../../../evals/acceptance/records";

const hash = "a".repeat(64);
function pair() {
  const baseline: AcceptanceManifest = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    role: "baseline",
    identity: {
      commit: "a".repeat(40),
      indexId: "baseline",
      indexSha256: hash,
      bunVersion: "1.3.10",
      nativeDependencies: { "node-llama-cpp": "3.16.0" },
      platform: "linux",
      architecture: "x64",
    },
    fixtureVersion: "synthetic-v1",
    fixtures: [{ path: "corpus.json", sha256: hash }],
    models: [
      {
        role: "embedding",
        id: "test-embed",
        sha256: hash,
        tokenizerSha256: hash,
      },
    ],
    cases: [
      {
        caseId: "rare-filter",
        fixtureSha256: hash,
        surface: "sdk",
        preset: "balanced",
        configuration: { collection: "allowed" },
      },
    ],
    intendedDeltas: [],
  };
  const candidate = structuredClone(baseline);
  candidate.role = "candidate";
  candidate.identity.indexId = "candidate";
  candidate.identity.commit = "b".repeat(40);
  const passage = {
    uri: "gno://allowed/a.md",
    sourceHash: hash,
    startLine: 1,
    endLine: 2,
    text: "exact\r\ntext",
    provenance: { spanHash: hash },
  };
  const a: AcceptanceRecord = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    manifestSha256: acceptanceManifestFingerprint(baseline),
    caseId: "rare-filter",
    deterministic: {
      scope: { collection: "allowed" },
      results: [
        {
          uri: passage.uri,
          score: 0.123456789,
          scores: { vector: 0.8 },
          passage,
          provenance: { collection: "allowed" },
        },
      ],
      citations: [passage],
      modelInputs: [
        {
          role: "embedding",
          modelId: "test-embed",
          input: { text: "exact query", options: { dimensions: 3 } },
        },
      ],
      semanticState: {
        status: "ok",
        vectorsUsed: false,
        vectorStatus: "not-requested",
        error: null,
        fallbacks: [],
        verification: { supported: true },
      },
    },
    generatedAnswer: "An answer",
    transport: { requestId: "first", capturedAt: "first", durationMs: 50 },
  };
  const b = structuredClone(a);
  b.manifestSha256 = acceptanceManifestFingerprint(candidate);
  return { baseline, candidate, a, b };
}

function compare(p: ReturnType<typeof pair>) {
  return compareAcceptance(p.baseline, p.candidate, [p.a], [p.b]);
}

test("unchanged control accepts only enumerated transport variation and freezes manifests", () => {
  const p = pair();
  p.b.transport = { requestId: "other", durationMs: 100, capturedAt: "later" };
  expect(compare(p)).toEqual({
    passed: true,
    comparedCases: 1,
    failures: [],
    generatedAnswerChanges: [],
  });
  const frozen = freezeAcceptanceManifest(p.baseline);
  expect(Object.isFrozen(frozen.cases[0]?.configuration)).toBe(true);
  expect(() =>
    compareAcceptance(
      p.baseline,
      p.candidate,
      [p.a],
      [{ ...p.b, transport: { hidden: "not volatile" } }]
    )
  ).toThrow();
});

const defects: Array<[string, (record: AcceptanceRecord) => void, string]> = [
  [
    "missing result",
    (r) => {
      r.deterministic.results = [];
    },
    "deterministic.results.length",
  ],
  [
    "scope leakage",
    (r) => {
      r.deterministic.results[0]!.uri = "gno://private/leak.md";
    },
    "deterministic.results[0].uri",
  ],
  [
    "false vector success",
    (r) => {
      r.deterministic.semanticState.vectorsUsed = true;
    },
    "deterministic.semanticState.vectorsUsed",
  ],
  [
    "changed actual model input",
    (r) => {
      r.deterministic.modelInputs[0]!.input = { text: "truncated" };
    },
    "deterministic.modelInputs[0].input.text",
  ],
  [
    "score precision",
    (r) => {
      r.deterministic.results[0]!.score += 0.000000001;
    },
    "deterministic.results[0].score",
  ],
  [
    "citation text",
    (r) => {
      r.deterministic.citations[0]!.text = "exact\ntext";
    },
    "deterministic.citations[0].text",
  ],
  [
    "semantic error",
    (r) => {
      r.deterministic.semanticState.error = { code: "unavailable" };
    },
    "deterministic.semanticState.error",
  ],
];
for (const [name, mutate, field] of defects) {
  test(`rejects ${name} independently with case and field`, () => {
    const p = pair();
    mutate(p.b);
    const result = compare(p);
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(
      expect.objectContaining({ caseId: "rare-filter", field })
    );
  });
}

test("fixture/model/tokenizer mismatches fail before candidate records are scored", () => {
  for (const mutate of [
    (m: AcceptanceManifest) => {
      m.fixtures[0]!.sha256 = "b".repeat(64);
    },
    (m: AcceptanceManifest) => {
      m.models[0]!.sha256 = "b".repeat(64);
    },
    (m: AcceptanceManifest) => {
      m.models[0]!.tokenizerSha256 = "b".repeat(64);
    },
  ]) {
    const p = pair();
    mutate(p.candidate);
    expect(() =>
      compareAcceptance(p.baseline, p.candidate, [], [null])
    ).toThrow("incompatible baseline/candidate identity");
  }
});

test("every manifest field is required, and duplicate cases are rejected", () => {
  const p = pair();
  for (const key of Object.keys(p.baseline)) {
    const incomplete = Object.fromEntries(
      Object.entries(p.baseline).filter(([field]) => field !== key)
    );
    expect(() => freezeAcceptanceManifest(incomplete)).toThrow();
  }
  p.baseline.cases.push(p.baseline.cases[0]!);
  expect(() => freezeAcceptanceManifest(p.baseline)).toThrow(
    "Duplicate identity"
  );
});

test("generated prose variability is reported without hiding citations or model inputs", () => {
  const p = pair();
  p.b.generatedAnswer = "A different phrasing";
  expect(compare(p)).toMatchObject({
    passed: true,
    generatedAnswerChanges: ["rare-filter"],
  });
  p.b.deterministic.citations = [];
  expect(compare(p).passed).toBe(false);
});

test("intended corrections require predeclared complete record oracles on both sides", () => {
  const p = pair();
  p.b.deterministic.results[0]!.score = 0.9;
  p.baseline.intendedDeltas = [
    {
      caseId: p.a.caseId,
      reason: "Correct score calculation",
      oracleSha256: hash,
      baselineRecordSha256: deterministicRecordFingerprint(p.a.deterministic),
      candidateRecordSha256: deterministicRecordFingerprint(p.b.deterministic),
    },
  ];
  p.candidate.intendedDeltas = structuredClone(p.baseline.intendedDeltas);
  p.a.manifestSha256 = acceptanceManifestFingerprint(p.baseline);
  p.b.manifestSha256 = acceptanceManifestFingerprint(p.candidate);
  expect(compare(p).passed).toBe(true);
  p.b.deterministic.citations = [];
  expect(compare(p).failures).toContainEqual(
    expect.objectContaining({
      field: "deterministic",
      reason: "candidate: Intended delta differs from complete oracle record",
    })
  );
});

test("missing, duplicate, unexpected and wrongly bound records fail closed", () => {
  const p = pair();
  for (const records of [
    [],
    [p.b, p.b],
    [{ ...p.b, caseId: "unknown" }],
    [{ ...p.b, manifestSha256: hash }],
  ]) {
    expect(
      compareAcceptance(p.baseline, p.candidate, [p.a], records).passed
    ).toBe(false);
  }
});

test("ordered results and model calls cannot be reordered", () => {
  for (const field of ["results", "modelInputs"] as const) {
    const p = pair();
    p.a.deterministic.results.push({
      ...structuredClone(p.a.deterministic.results[0]!),
      uri: "gno://allowed/b.md",
    });
    p.a.deterministic.modelInputs.push({
      role: "embedding",
      modelId: "test-embed",
      input: "second call",
    });
    p.b.deterministic = structuredClone(p.a.deterministic);
    p.b.deterministic[field].reverse();
    expect(compare(p).passed).toBe(false);
  }
});

test("distinct expansion and answer generation models coexist but duplicate role and id fail", () => {
  const p = pair();
  p.baseline.models.push(
    {
      role: "generation",
      id: "expansion",
      sha256: hash,
      tokenizerSha256: hash,
    },
    {
      role: "generation",
      id: "answer",
      sha256: "b".repeat(64),
      tokenizerSha256: "b".repeat(64),
    }
  );
  p.candidate.models = structuredClone(p.baseline.models);
  p.a.manifestSha256 = acceptanceManifestFingerprint(p.baseline);
  p.b.manifestSha256 = acceptanceManifestFingerprint(p.candidate);
  expect(compare(p).passed).toBe(true);
  p.baseline.models.push({
    role: "generation",
    id: "answer",
    sha256: hash,
    tokenizerSha256: hash,
  });
  expect(() => freezeAcceptanceManifest(p.baseline)).toThrow(
    "Duplicate identity"
  );
});
