import { describe, expect, test } from "bun:test";

import { sha256Text } from "../../../src/core/context-capsule-validation";
import { verifyContextCapsule } from "../../../src/core/context-verifier";
import {
  claimVerificationResultSchema,
  verifyClaimsDeterministically,
} from "../../../src/pipeline/claim-verification";
import {
  capsuleFor,
  createVerifierStore,
  verifierDeps,
  verifierFixture,
} from "../../core/context-verifier-fixture";
import { assertInvalid, assertValid, loadSchema } from "./validator";

const productionResult = async () => {
  const fixture = verifierFixture(false);
  const { store } = createVerifierStore(fixture.state);
  const capsule = await capsuleFor(store, fixture.state);
  const receipt = await verifyContextCapsule(
    capsule,
    verifierDeps(store, capsule)
  );
  const evidence = capsule.evidence[0]!;
  const answer = `Mina owns it [evidence:${evidence.evidenceId}] and cites [evidence:${sha256Text("outside")}].`;
  return verifyClaimsDeterministically({
    answer,
    capsule,
    freshness: receipt,
  });
};

const nestedObjects = (value: unknown): Record<string, unknown>[] => {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nestedObjects);
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(nestedObjects)];
};

describe("claim verification JSON-schema parity", () => {
  test("accepts the deterministic production result", async () => {
    const schema = await loadSchema("claim-verification");
    const result = await productionResult();
    expect(claimVerificationResultSchema.parse(result)).toEqual(result);
    expect(assertValid(result, schema)).toBe(true);
  });

  test("rejects extension fields at every nested output object", async () => {
    const schema = await loadSchema("claim-verification");
    const result = await productionResult();
    const objectCount = nestedObjects(result).length;
    expect(objectCount).toBeGreaterThanOrEqual(5);

    for (let index = 0; index < objectCount; index += 1) {
      const mutated = structuredClone(result);
      const target = nestedObjects(mutated)[index];
      if (!target) throw new Error(`Missing nested object ${index}`);
      target.unexpected = true;
      expect(claimVerificationResultSchema.safeParse(mutated).success).toBe(
        false
      );
      expect(assertInvalid(mutated, schema)).toBe(true);
    }
  });

  test("keeps semantic statuses, evidence, and abstention coherent", async () => {
    const schema = await loadSchema("claim-verification");
    const result = await productionResult();
    const claim = result.claims[0]!;

    const impossibleSupport = {
      ...result,
      claims: [
        {
          ...claim,
          status: "supported",
          rationaleCode: "semantic_entailment",
        },
      ],
    };
    expect(
      claimVerificationResultSchema.safeParse(impossibleSupport).success
    ).toBe(false);
    expect(assertInvalid(impossibleSupport, schema)).toBe(true);
    const impossibleAggregate = {
      ...result,
      abstained: false,
      answerStatus: "verified",
      abstentionReason: null,
      abstentionText: null,
    };
    expect(
      claimVerificationResultSchema.safeParse(impossibleAggregate).success
    ).toBe(false);
    expect(assertInvalid(impossibleAggregate, schema)).toBe(true);

    const nestedRejectedVerified = {
      ...result,
      claims: [
        {
          ...claim,
          status: "supported",
          confidence: 0.9,
          rationaleCode: "semantic_entailment",
          verifierFingerprint: sha256Text("verifier"),
        },
      ],
      coverage: {
        totalClaims: 1,
        supportedClaims: 1,
        contradictedClaims: 0,
        insufficientClaims: 0,
        uncertainClaims: 0,
        supportedRatio: 1,
      },
      answerStatus: "verified",
      abstained: false,
      abstentionReason: null,
      abstentionText: null,
    };
    expect(
      claimVerificationResultSchema.safeParse(nestedRejectedVerified).success
    ).toBe(false);
    expect(assertInvalid(nestedRejectedVerified, schema)).toBe(true);
    expect(
      assertInvalid(
        {
          ...result,
          claims: [
            {
              ...claim,
              status: "uncertain",
              rationaleCode: "semantic_contradiction",
            },
          ],
        },
        schema
      )
    ).toBe(true);
  });
});
