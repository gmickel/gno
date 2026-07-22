import { describe, expect, test } from "bun:test";

import { validateTrajectoryAccounting } from "../../../evals/agentic/validation";
import { receiptFixture } from "./fixtures";

describe("trajectory failure accounting", () => {
  test("binds one terminal undelivered call to the receipt failure", () => {
    const valid = receiptFixture();
    const call = valid.canonical.calls[0]!;
    call.deliveredToAgent = false;
    call.failureCode = "context_byte_budget_exceeded";
    call.modelVisibleUtf8Bytes = 0;
    call.measuredTokens = null;
    call.tokenizerFingerprint = null;
    valid.canonical.modelVisibleUtf8Bytes = 0;
    valid.canonical.measuredTokens = null;
    valid.canonical.finalEnvelope = null;
    valid.canonical.stopReason = "error";
    valid.canonical.failure = {
      class: "agent_error",
      code: "context_byte_budget_exceeded",
      redactedMessage: null,
    };
    expect(validateTrajectoryAccounting(valid)).not.toContain(
      "undelivered_call_failure_mismatch"
    );

    const falseZeroTokens = structuredClone(valid);
    falseZeroTokens.canonical.measuredTokens = 0;
    expect(validateTrajectoryAccounting(falseZeroTokens)).toContain(
      "measured_tokens_mismatch"
    );

    const conflicting = structuredClone(valid);
    conflicting.canonical.calls[0]!.failureCode = "tampered_failure";
    expect(validateTrajectoryAccounting(conflicting)).toContain(
      "undelivered_call_failure_mismatch"
    );

    const nonterminal = structuredClone(valid);
    nonterminal.canonical.calls.push({
      ...structuredClone(receiptFixture().canonical.calls[0]!),
      callIndex: 1,
    });
    expect(validateTrajectoryAccounting(nonterminal)).toContain(
      "undelivered_call_failure_mismatch"
    );

    const multiple = structuredClone(valid);
    multiple.canonical.calls.push({
      ...structuredClone(valid.canonical.calls[0]!),
      callIndex: 1,
    });
    expect(validateTrajectoryAccounting(multiple)).toContain(
      "undelivered_call_failure_mismatch"
    );
  });
});
