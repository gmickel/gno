import { describe, expect, mock, test } from "bun:test";

import type { GenerationPort, LlmResult } from "../../src/llm/types";

import {
  mapAnswerCitationsToEvidence,
  synthesizeVerifiedAsk,
} from "../../src/app/verified-ask";
import { formatAsk } from "../../src/cli/commands/ask";
import { createDefaultConfig } from "../../src/config";
import { verifyContextCapsule } from "../../src/core/context-verifier";
import { formatVerifiedAskReadable } from "../../src/mcp/tools/ask";
import { CITATION_TRACE_METADATA } from "../../src/pipeline/types";
import {
  capsuleFor,
  createVerifierStore,
  verifierDeps,
  verifierFixture,
} from "../core/context-verifier-fixture";
import {
  assertInvalid,
  assertValid,
  loadSchema,
} from "../spec/schemas/validator";

const setup = async () => {
  const fixture = verifierFixture(false);
  const harness = createVerifierStore(fixture.state);
  const capsule = await capsuleFor(harness.store, fixture.state);
  const freshness = await verifyContextCapsule(
    capsule,
    verifierDeps(harness.store, capsule)
  );
  return { capsule, freshness };
};

const portWith = (
  generate: GenerationPort["generate"],
  structuredOutput: GenerationPort["structuredOutput"] = "json_schema"
) => {
  const generateMock = mock(generate);
  return {
    generateMock,
    port: {
      modelUri: "file:/verified-ask.gguf",
      structuredOutput,
      generate: generateMock,
      dispose: async () => {},
    } satisfies GenerationPort,
  };
};

describe("verified Ask synthesis", () => {
  test("maps numeric citations to exact immutable Capsule evidence IDs", async () => {
    const { capsule } = await setup();

    expect(mapAnswerCitationsToEvidence("Owner [2]. Bad [9].", capsule)).toBe(
      `Owner [evidence:${capsule.evidence[1]!.evidenceId}]. Bad .`
    );
  });

  test("returns a fully supported answer with exact evidence and one verifier call", async () => {
    const { capsule, freshness } = await setup();
    const first = capsule.evidence[0]!;
    const { port, generateMock } = portWith(
      async (_prompt, params): Promise<LlmResult<string>> => {
        if (!params?.jsonSchema) {
          return { ok: true, value: "Mina owns the decision [1]." };
        }
        const schema = params.jsonSchema as {
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
        };
        const properties = schema.properties.judgments.items.properties;
        return {
          ok: true,
          value: JSON.stringify({
            judgments: [
              {
                claimId: properties.claimId.enum[0],
                verdict: "supported",
                confidence: 0.99,
                evidenceIds: [properties.evidenceIds.items.enum[0]],
                rationaleCode: "semantic_entailment",
              },
            ],
            unresolvedClaimIds: [],
          }),
        };
      }
    );

    const result = await synthesizeVerifiedAsk(
      "Who owns the decision?",
      { verify: true },
      capsule,
      freshness,
      {
        config: createDefaultConfig(),
        genPort: port,
        indexName: "default",
      }
    );

    expect(result.answer).toBe(
      `Mina owns the decision [evidence:${first.evidenceId}].`
    );
    expect(result.citations).toEqual([
      expect.objectContaining({
        evidenceId: first.evidenceId,
        uri: first.uri,
        startLine: first.startLine,
        endLine: first.endLine,
      }),
    ]);
    expect(result.citations?.[0]?.[CITATION_TRACE_METADATA]).toMatchObject({
      rank: first.selectionRank,
      plannerRank: first.retrievalRank,
      sources: first.retrievalSources,
      graphExpanded: first.graphExpanded,
    });
    expect(result.verification?.claims).toMatchObject({
      answerStatus: "verified",
      abstained: false,
      coverage: { supportedRatio: 1 },
    });
    expect(result.verification?.capsule).toBe(capsule);
    expect(result.verification?.freshness).toBe(freshness);
    expect(generateMock).toHaveBeenCalledTimes(2);

    const schema = await loadSchema("ask");
    expect(assertValid(result, schema)).toBe(true);
    const malformed = structuredClone(result) as typeof result & {
      verification: NonNullable<typeof result.verification> & {
        semantic: NonNullable<typeof result.verification>["semantic"] & {
          leaked: boolean;
        };
      };
    };
    if (!malformed.verification) throw new Error("verification missing");
    malformed.verification.semantic.leaked = true;
    expect(assertInvalid(malformed, schema)).toBe(true);

    const contradictoryMeta = structuredClone(result);
    contradictoryMeta.meta.verificationRequested = false;
    expect(assertInvalid(contradictoryMeta, schema)).toBe(true);

    const missingEvidenceId = structuredClone(result);
    delete missingEvidenceId.citations?.[0]?.evidenceId;
    expect(assertInvalid(missingEvidenceId, schema)).toBe(true);

    const missingVerification = structuredClone(result);
    delete missingVerification.verification;
    expect(assertInvalid(missingVerification, schema)).toBe(true);

    expect(assertInvalid({ ...result, unexpected: true }, schema)).toBe(true);

    const terminal = formatAsk(
      { success: true, data: result },
      { json: false, md: false }
    );
    const markdown = formatAsk({ success: true, data: result }, { md: true });
    const mcp = formatVerifiedAskReadable(result);
    for (const readable of [terminal, markdown, mcp]) {
      expect(readable).toContain("supported");
      expect(readable).toContain(
        `${first.uri}:L${first.startLine}${first.endLine === first.startLine ? "" : `-L${first.endLine}`}`
      );
    }
    expect(terminal).toContain("[1]");
    expect(terminal).not.toContain(`[evidence:${first.evidenceId}]`);
    expect(markdown).toContain("[1]");
    expect(mcp).toContain("Semantic verifier: completed");
    expect(mcp).toContain("Capability: semanticSearch unavailable");
    const terminalWithSources = formatAsk(
      { success: true, data: result },
      { json: false, md: false, showSources: true }
    );
    const markdownWithSources = formatAsk(
      { success: true, data: result },
      { md: true, showSources: true }
    );
    for (const readable of [terminalWithSources, markdownWithSources]) {
      expect(readable).toContain("All Capsule Evidence");
      expect(readable).toContain(
        `${first.uri}:L${first.startLine}${first.endLine === first.startLine ? "" : `-L${first.endLine}`}`
      );
    }
    const withGap = structuredClone(result);
    if (!withGap.verification) throw new Error("verification missing");
    withGap.verification.capsule.coverage.unresolvedFacets.push("reviewer");
    withGap.verification.capsule.coverage.gaps.push({
      facet: "reviewer",
      code: "facet_not_found",
    });
    const mcpWithGap = formatVerifiedAskReadable(withGap);
    expect(mcpWithGap).toContain("Unresolved facet: reviewer");
    expect(mcpWithGap).toContain("Gap: reviewer (facet_not_found)");
  });

  test("abstains explicitly when the verifier cannot establish full support", async () => {
    const { capsule, freshness } = await setup();
    const { port } = portWith(async (_prompt, params) =>
      params?.jsonSchema
        ? {
            ok: true,
            value: JSON.stringify({
              judgments: [],
              unresolvedClaimIds: (
                params.jsonSchema as {
                  properties: {
                    unresolvedClaimIds: { items: { enum: string[] } };
                  };
                }
              ).properties.unresolvedClaimIds.items.enum,
            }),
          }
        : { ok: true, value: "Mina owns the decision [1]." }
    );

    const result = await synthesizeVerifiedAsk(
      "Who owns the decision?",
      { verify: true },
      capsule,
      freshness,
      {
        config: createDefaultConfig(),
        genPort: port,
        indexName: "default",
      }
    );

    expect(result.meta.abstained).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.answer).toBe(
      "I cannot provide this answer as verified from the supplied Context Capsule."
    );
    expect(result.verification?.claims).toMatchObject({
      answerStatus: "abstained",
      abstentionReason: "coverage_below_threshold",
      coverage: { uncertainClaims: 1, supportedRatio: 0 },
    });
    expect(assertValid(result, await loadSchema("ask"))).toBe(true);
  });
});
