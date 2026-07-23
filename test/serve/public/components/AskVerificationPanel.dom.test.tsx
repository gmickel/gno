import { screen } from "@testing-library/react";
import { describe, expect, mock, test } from "bun:test";

import type { AskVerification } from "../../../../src/serve/public/components/AskVerificationPanel";

import { AskVerificationPanel } from "../../../../src/serve/public/components/AskVerificationPanel";
import { renderWithUser } from "../../../helpers/dom";

const verification = {
  claims: {
    answerStatus: "abstained",
    abstained: true,
    abstentionReason: "coverage_below_threshold",
    coverage: {
      totalClaims: 4,
      supportedClaims: 1,
      contradictedClaims: 1,
      insufficientClaims: 1,
      uncertainClaims: 1,
      supportedRatio: 0.25,
    },
    claims: [
      {
        claimId: "claim-1",
        text: "Mina owns the decision.",
        status: "supported",
        evidence: [
          {
            evidenceId: "a".repeat(64),
            uri: "gno://notes/decision.md",
            startLine: 7,
            endLine: 8,
          },
        ],
        rationaleCode: "semantic_entailment",
        confidence: 0.98,
      },
      {
        claimId: "claim-2",
        text: "The deadline is Friday.",
        status: "contradicted",
        evidence: [
          {
            evidenceId: "b".repeat(64),
            uri: "gno://notes/schedule.md",
            startLine: 12,
            endLine: 12,
          },
        ],
        rationaleCode: "semantic_contradiction",
        confidence: 0.91,
      },
      {
        claimId: "claim-3",
        text: "The reviewer approved the launch.",
        status: "insufficient",
        evidence: [],
        rationaleCode: "no_retained_evidence",
        confidence: null,
      },
      {
        claimId: "claim-4",
        text: "The launch risk is low.",
        status: "uncertain",
        evidence: [],
        rationaleCode: "semantic_uncertain",
        confidence: 0.42,
      },
    ],
  },
  capsule: {
    capsuleId: "c".repeat(64),
    evidence: [{ text: "PRIVATE FULL CAPSULE PASSAGE" }],
    retrieval: {
      capabilityStates: {
        semanticSearch: {
          requested: true,
          outcome: "unavailable",
          fallbackReasons: ["model_unavailable"],
        },
        reranking: {
          requested: false,
          outcome: "not_requested",
          fallbackReasons: [],
        },
      },
    },
    coverage: {
      unresolvedFacets: ["deadline"],
      gaps: [{ facet: "deadline", code: "facet_not_found" }],
    },
  },
  semantic: {
    status: "completed",
    reason: "verified",
  },
} as unknown as AskVerification;

describe("AskVerificationPanel", () => {
  test("renders verdicts, exact evidence, gaps, and degradation", async () => {
    const navigate = mock(() => undefined);
    const { user } = renderWithUser(
      <AskVerificationPanel navigate={navigate} verification={verification} />
    );

    const panel = screen.getByText("Answer withheld").closest("details");
    expect(panel?.open).toBe(false);
    await user.click(screen.getByText("Answer withheld"));
    expect(panel?.open).toBe(true);

    expect(screen.getByText("1/4 supported")).toBeTruthy();
    expect(screen.getByText("supported")).toBeTruthy();
    expect(screen.getByText("contradicted")).toBeTruthy();
    expect(screen.getByText("insufficient")).toBeTruthy();
    expect(screen.getByText("uncertain")).toBeTruthy();
    expect(screen.getByText("semantic: completed/verified")).toBeTruthy();
    expect(
      screen.getByText("semanticSearch: unavailable (model_unavailable)")
    ).toBeTruthy();
    expect(screen.getByText("unresolved facet: deadline")).toBeTruthy();
    expect(screen.getByText("deadline: facet_not_found")).toBeTruthy();

    const evidence = screen.getByRole("button", {
      name: "gno://notes/decision.md:L7-L8",
    });
    expect(
      screen.getByRole("button", {
        name: "gno://notes/schedule.md:L12",
      })
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain(
      "PRIVATE FULL CAPSULE PASSAGE"
    );
    expect(document.body.textContent).not.toContain("cccccccccccccccc");
    await user.click(evidence);
    expect(navigate).toHaveBeenCalledWith(
      "/doc?uri=gno%3A%2F%2Fnotes%2Fdecision.md"
    );
  });
});
