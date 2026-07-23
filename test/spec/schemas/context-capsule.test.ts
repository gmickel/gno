import { describe, expect, test } from "bun:test";

import type { ContextCapsulePayloadV1 } from "../../../src/core/context-capsule-schema";

import { deriveDocid } from "../../../src/app/constants";
import {
  canonicalContextCapsuleJson,
  canonicalContextCapsuleAccountingJson,
  ContextCapsuleContractError,
  type ContextCapsuleErrorCode,
  createContextCapsuleV1,
  parseContextCapsuleV1,
} from "../../../src/core/context-capsule";
import {
  contextCapsuleGnoUriSchema,
  contextCapsulePrefixUriSchema,
} from "../../../src/core/context-capsule-schema";
import {
  contextCapsuleContextIdentity,
  contextCapsuleEvidenceIdentity,
  contextCapsuleOmissionIdentity,
  sha256Text,
} from "../../../src/core/context-capsule-validation";
import { parseCanonicalContextCapsuleForVerification } from "../../../src/core/context-verifier";
import {
  assertInvalid,
  assertValid,
  createValidator,
  loadSchema,
} from "./validator";

const HASH = {
  config: sha256Text("config"),
  index: sha256Text("index"),
  mirror: sha256Text("mirror"),
  retrieval: sha256Text("retrieval"),
  source: sha256Text("source"),
  tokenizer: sha256Text("tokenizer"),
};

const buildPayload = (
  overrides: Partial<ContextCapsulePayloadV1> = {}
): ContextCapsulePayloadV1 => {
  const passage = "The decision owner is Mina.\nReview is due Friday.";
  const contextText = "Prefer signed decision records.";
  const contextId = contextCapsuleContextIdentity({
    scopeType: "collection",
    scopeKey: "notes:",
    text: contextText,
  });
  const evidenceBase = {
    uri: "gno://notes/decision.md",
    docid: deriveDocid(HASH.source),
    startLine: 4,
    endLine: 5,
    sourceHash: HASH.source,
    mirrorHash: HASH.mirror,
    passageHash: sha256Text(passage),
  };
  const evidenceId = contextCapsuleEvidenceIdentity(evidenceBase);
  const payload: ContextCapsulePayloadV1 = {
    schemaVersion: "1.0",
    coordinateSpace: "canonical_mirror",
    goal: "Find the decision owner",
    query: "decision owner",
    scope: {
      indexName: "default",
      collections: ["notes"],
      uriPrefix: null,
      tagsAll: [],
      tagsAny: [],
      categories: [],
      since: null,
      until: null,
    },
    budget: {
      authority: "canonical_json",
      requestedTokens: 100_000,
      requestedBytes: 100_000,
      safetyMarginTokens: 0,
      safetyMarginBytes: 0,
      usedTokens: 1,
      usedBytes: 0,
      estimator: "unicode_conservative",
      tokenizerFingerprint: null,
    },
    retrieval: {
      depthPolicy: "balanced",
      facets: ["decision owner"],
      queryVariants: ["decision owner"],
      expansionPolicy: "deterministic_only",
      request: {
        author: null,
        lang: null,
        queryModes: [],
        limit: 20,
        candidateLimit: 40,
        graphRequested: false,
      },
      capabilityStates: {
        semanticSearch: {
          requested: true,
          attempted: true,
          outcome: "unavailable",
          fallbackReasons: ["embedding_unavailable"],
        },
        reranking: {
          requested: true,
          attempted: true,
          outcome: "unavailable",
          fallbackReasons: ["reranking_unavailable"],
        },
        graphExpansion: {
          requested: false,
          attempted: false,
          outcome: "not_requested",
          fallbackReasons: [],
        },
      },
      indexSnapshot: { before: HASH.index, after: HASH.index, stable: true },
    },
    fingerprints: {
      config: HASH.config,
      retrieval: HASH.retrieval,
      embeddingModel: null,
      rerankModel: null,
      tokenizer: null,
    },
    capabilities: {
      lexicalSearch: true,
      semanticSearch: false,
      reranking: false,
      graphExpansion: false,
      exactTokenCount: false,
      configuredContext: true,
      egressPolicy: false,
    },
    fallbacks: [
      { code: "embedding_unavailable", capability: "semantic_search" },
      { code: "reranking_unavailable", capability: "reranking" },
      { code: "tokenizer_unavailable", capability: "token_count" },
      { code: "egress_policy_unavailable", capability: "egress_policy" },
    ],
    guidance: {
      extractiveOnly: true,
      evidenceTrust: "untrusted_data",
      instructionBoundary: "hard_delimited",
      configuredContexts: [
        {
          contextId,
          scopeType: "collection",
          scopeKey: "notes:",
          text: contextText,
        },
      ],
    },
    evidence: [
      {
        evidenceId,
        ...evidenceBase,
        collection: "notes",
        title: "Decision record",
        heading: "Owner",
        text: passage,
        modifiedAt: "2026-07-22T10:00:00+02:00",
        documentDate: "2026-07-21",
        observedAt: "2026-07-22T08:30:00Z",
        contextIds: [contextId],
        retrievalRank: 1,
        selectionRank: 1,
        retrievalSources: ["bm25"],
        graphExpanded: false,
        facets: ["decision owner"],
        trust: "untrusted",
        egress: "unavailable",
      },
    ],
    coverage: {
      complete: true,
      requestedFacets: ["decision owner"],
      coveredFacets: [{ facet: "decision owner", evidenceIds: [evidenceId] }],
      unresolvedFacets: [],
      gaps: [],
    },
    omissions: {
      total: 0,
      items: [],
      reasonCounts: {
        duplicate: 0,
        overlap: 0,
        global_budget: 0,
        redundant_coverage: 0,
        document_share_cap: 0,
        filtered_by_scope: 0,
        invalid_coordinates: 0,
      },
      truncated: false,
    },
    truncated: false,
    warnings: [{ code: "token_estimate_used" }],
  };
  return { ...payload, ...overrides };
};

const expectContractCode = (
  run: () => unknown,
  code: ContextCapsuleErrorCode
): void => {
  try {
    run();
    throw new Error("Expected Context Capsule contract failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ContextCapsuleContractError);
    expect((error as ContextCapsuleContractError).code).toBe(code);
  }
};

describe("Context Capsule V1 contract", () => {
  test("accepts legacy V1 evidence without additive provenance fields", () => {
    const legacyPayload = structuredClone(buildPayload());
    const evidence = legacyPayload.evidence[0];
    if (!evidence) throw new Error("evidence fixture missing");
    delete evidence.retrievalSources;
    delete evidence.graphExpanded;

    const legacyCapsule = createContextCapsuleV1(legacyPayload);
    expect(legacyCapsule.evidence[0]?.retrievalSources).toBeUndefined();
    expect(legacyCapsule.evidence[0]?.graphExpanded).toBeUndefined();
    expect(parseCanonicalContextCapsuleForVerification(legacyCapsule)).toEqual(
      legacyCapsule
    );
  });

  test("uses stable identity and non-self-referential accounting projections", async () => {
    const schema = await loadSchema("context-capsule-v1");
    const first = createContextCapsuleV1(buildPayload());
    const second = createContextCapsuleV1(buildPayload());
    const { capsuleId: _capsuleId, ...createdPayload } = first;
    expect(createContextCapsuleV1(createdPayload)).toEqual(first);
    const canonical = canonicalContextCapsuleJson(first);

    expect(canonicalContextCapsuleJson(second)).toBe(canonical);
    expect(first.capsuleId).toHaveLength(64);
    expect(first.budget.usedBytes).toBe(
      new TextEncoder().encode(canonical).byteLength
    );
    expect(first.budget.usedTokens).toBe(first.budget.usedBytes);
    const accounting = canonicalContextCapsuleAccountingJson(first);
    expect(accounting).not.toContain('"usedBytes"');
    expect(accounting).not.toContain('"usedTokens"');
    expect(
      createContextCapsuleV1({
        ...buildPayload(),
        budget: { ...buildPayload().budget, usedBytes: 999, usedTokens: 999 },
      }).capsuleId
    ).toBe(first.capsuleId);
    expect(assertValid(first, schema)).toBe(true);

    expect(() =>
      parseContextCapsuleV1({ ...first, capsuleId: "f".repeat(64) })
    ).toThrow(ContextCapsuleContractError);
    expect(
      createContextCapsuleV1({ ...buildPayload(), goal: "Different goal" })
        .capsuleId
    ).not.toBe(first.capsuleId);
  });

  test("keeps Draft-07 and Zod canonical GNO URI rejection in parity", async () => {
    const schema = (await loadSchema("context-capsule-v1")) as {
      definitions: { gnoUri: object; gnoPrefixUri: object };
    };
    const validateDraftUri = createValidator(schema.definitions.gnoUri);
    const validateDraftPrefixUri = createValidator(
      schema.definitions.gnoPrefixUri
    );
    const vectors = [
      ["gno://notes/decision.md", true],
      ["gno://notes/my%20decision.md?index=research", true],
      ["gno://Notes/decision.md", false],
      ["gno://notes/folder%2Fdecision.md", false],
      ["gno://notes/folder%2fdecision.md", false],
      ["gno://notes/decision.md?unknown=value", false],
    ] as const;
    for (const [uri, expected] of vectors) {
      expect(contextCapsuleGnoUriSchema.safeParse(uri).success).toBe(expected);
      expect(validateDraftUri(uri)).toBe(expected);
    }
    const prefixVectors = [
      ["gno://notes/", true],
      ["gno://notes/?index=research", true],
      ["gno://notes/projects", true],
      ["gno://notes", false],
      ["gno://Notes/", false],
    ] as const;
    for (const [uri, expected] of prefixVectors) {
      expect(contextCapsulePrefixUriSchema.safeParse(uri).success).toBe(
        expected
      );
      expect(validateDraftPrefixUri(uri)).toBe(expected);
    }
  });

  test("accepts canonical collection-root configured prefix context", async () => {
    const schema = await loadSchema("context-capsule-v1");
    const payload = buildPayload();
    const text = "Collection-root guidance";
    const contextId = contextCapsuleContextIdentity({
      scopeType: "prefix",
      scopeKey: "gno://notes/",
      text,
    });
    const capsule = createContextCapsuleV1({
      ...payload,
      guidance: {
        ...payload.guidance,
        configuredContexts: [
          {
            contextId,
            scopeType: "prefix",
            scopeKey: "gno://notes/",
            text,
          },
        ],
      },
      evidence: [{ ...payload.evidence[0], contextIds: [contextId] }],
    });

    expect(assertValid(capsule, schema)).toBe(true);
    expect(
      parseContextCapsuleV1(capsule).guidance.configuredContexts[0]
    ).toEqual({
      contextId,
      scopeType: "prefix",
      scopeKey: "gno://notes/",
      text,
    });
  });

  test("rejects unknown versions, fields, secrets, paths, and volatile timing", async () => {
    const schema = await loadSchema("context-capsule-v1");
    const capsule = createContextCapsuleV1(buildPayload());
    const invalid = [
      { ...capsule, schemaVersion: "2.0" },
      { ...capsule, elapsedMs: 4 },
      { ...capsule, outputPath: "/tmp/capsule.json" },
      { ...capsule, secret: "canary-secret" },
      { ...capsule, modelUri: "file:///private/model.gguf" },
      { ...capsule, budget: { ...capsule.budget, localPath: "/tmp" } },
      {
        ...capsule,
        evidence: [{ ...capsule.evidence[0], rawScore: 0.99 }],
      },
      {
        ...capsule,
        evidence: [
          {
            ...capsule.evidence[0],
            uri: "gno://notes/decision.md?unknown=value",
          },
        ],
      },
    ];

    for (const value of invalid) {
      expect(assertInvalid(value, schema)).toBe(true);
      expect(() => parseContextCapsuleV1(value)).toThrow();
      expect(JSON.stringify(capsule)).not.toContain("canary-secret");
    }
  });

  test("binds exact canonical-mirror evidence bytes, hashes, coordinates, and docid", () => {
    const decomposed = "Cafe\u0301\n第二行";
    const sourceHash = sha256Text("unicode-source");
    const evidenceBase = {
      uri: "gno://notes/unicode.md",
      docid: deriveDocid(sourceHash),
      startLine: 1,
      endLine: 2,
      sourceHash,
      mirrorHash: sha256Text("unicode-mirror"),
      passageHash: sha256Text(decomposed),
    };
    const payload = buildPayload();
    const evidenceId = contextCapsuleEvidenceIdentity(evidenceBase);
    const evidence = {
      ...payload.evidence[0],
      ...evidenceBase,
      evidenceId,
      text: decomposed,
    };
    const capsule = createContextCapsuleV1({
      ...payload,
      evidence: [evidence],
      coverage: {
        ...payload.coverage,
        coveredFacets: [{ facet: "decision owner", evidenceIds: [evidenceId] }],
      },
    });

    expect(capsule.evidence[0]?.text).toBe(decomposed);
    expect(() =>
      createContextCapsuleV1({
        ...payload,
        evidence: [{ ...payload.evidence[0], text: "changed" }],
      })
    ).toThrow();
    expect(() =>
      createContextCapsuleV1({
        ...payload,
        evidence: [{ ...payload.evidence[0], text: "line one\r\nline two" }],
      })
    ).toThrow();
  });

  test("enforces the global budget and requires an exact tokenizer callback", () => {
    expectContractCode(
      () =>
        createContextCapsuleV1({
          ...buildPayload(),
          budget: { ...buildPayload().budget, requestedBytes: 100 },
        }),
      "invalid_budget"
    );
    const payload = buildPayload();
    const active = {
      ...payload,
      budget: {
        ...payload.budget,
        estimator: "active_tokenizer" as const,
        tokenizerFingerprint: HASH.tokenizer,
      },
      fingerprints: { ...payload.fingerprints, tokenizer: HASH.tokenizer },
      capabilities: { ...payload.capabilities, exactTokenCount: true },
      fallbacks: payload.fallbacks.filter(
        (item) => item.code !== "tokenizer_unavailable"
      ),
      warnings: [],
    };

    expectContractCode(() => createContextCapsuleV1(active), "invalid_budget");
    const exact = createContextCapsuleV1(active, {
      countTokens: (accounting) => {
        expect(accounting).not.toContain('"usedTokens"');
        return 17;
      },
    });
    expect(exact.budget.usedTokens).toBe(17);
    const tampered = {
      ...exact,
      budget: { ...exact.budget, usedTokens: 18 },
    };
    expect(parseContextCapsuleV1(tampered).budget.usedTokens).toBe(18);
    expectContractCode(
      () => parseContextCapsuleV1(tampered, { countTokens: () => 17 }),
      "invalid_budget"
    );

    const fallback = createContextCapsuleV1(payload);
    expectContractCode(
      () =>
        parseContextCapsuleV1({
          ...fallback,
          budget: {
            ...fallback.budget,
            usedTokens: fallback.budget.usedBytes - 1,
          },
        }),
      "invalid_budget"
    );
  });

  test("rejects empty evidence but accepts explicit incomplete coverage", async () => {
    expectContractCode(
      () => createContextCapsuleV1({ ...buildPayload(), evidence: [] }),
      "no_evidence"
    );
    const payload = buildPayload();
    const incomplete = createContextCapsuleV1({
      ...payload,
      retrieval: {
        ...payload.retrieval,
        facets: ["decision owner", "deadline"],
      },
      evidence: [{ ...payload.evidence[0], facets: ["decision owner"] }],
      coverage: {
        complete: false,
        requestedFacets: ["decision owner", "deadline"],
        coveredFacets: payload.coverage.coveredFacets,
        unresolvedFacets: ["deadline"],
        gaps: [{ facet: "deadline", code: "facet_not_found" }],
      },
      warnings: [
        { code: "incomplete_coverage" },
        { code: "token_estimate_used" },
      ],
    });
    expect(incomplete.coverage.complete).toBe(false);
    const schema = await loadSchema("context-capsule-v1");
    for (const gap of [
      { facet: null, code: "facet_not_found" },
      { facet: "deadline", code: "no_evidence" },
    ]) {
      const invalid = {
        ...incomplete,
        coverage: { ...incomplete.coverage, gaps: [gap] },
      };
      expect(assertInvalid(invalid, schema)).toBe(true);
      expect(() => parseContextCapsuleV1(invalid)).toThrow();
    }
  });

  test("binds retrieval facets and evidence URI fields to requested scope", () => {
    const payload = buildPayload();
    const mismatches = [
      { ...payload, retrieval: { ...payload.retrieval, facets: ["other"] } },
      {
        ...payload,
        evidence: [{ ...payload.evidence[0], collection: "other" }],
      },
      { ...payload, scope: { ...payload.scope, collections: ["other"] } },
      { ...payload, scope: { ...payload.scope, indexName: "research" } },
      {
        ...payload,
        scope: { ...payload.scope, uriPrefix: "gno://notes/other" },
      },
    ];
    for (const mismatch of mismatches) {
      expect(() => createContextCapsuleV1(mismatch)).toThrow();
    }
  });

  test("records budget margins and revision-bound per-reason omissions", async () => {
    const payload = buildPayload();
    const omitted = {
      uri: "gno://notes/other.md",
      docid: deriveDocid(HASH.source),
      startLine: null,
      endLine: null,
      passageHash: null,
      sourceHash: HASH.source,
      mirrorHash: HASH.mirror,
    };
    const capsule = createContextCapsuleV1({
      ...payload,
      budget: {
        ...payload.budget,
        safetyMarginTokens: 64,
        safetyMarginBytes: 64,
      },
      omissions: {
        total: 1,
        items: [
          {
            ...omitted,
            candidateId: contextCapsuleOmissionIdentity(omitted),
            reason: "document_share_cap",
          },
        ],
        reasonCounts: {
          ...payload.omissions.reasonCounts,
          document_share_cap: 1,
        },
        truncated: false,
      },
    });
    expect(assertValid(capsule, await loadSchema("context-capsule-v1"))).toBe(
      true
    );
    expect(() =>
      createContextCapsuleV1({
        ...payload,
        budget: { ...payload.budget, safetyMarginBytes: -1 },
      })
    ).toThrow();
    expect(() =>
      parseContextCapsuleV1({
        ...capsule,
        omissions: {
          ...capsule.omissions,
          items: [{ ...capsule.omissions.items[0], sourceHash: HASH.config }],
        },
      })
    ).toThrow();
  });
});
