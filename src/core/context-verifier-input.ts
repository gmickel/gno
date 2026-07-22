/** Canonical verification input preflight; performs no store I/O. */

import type { ContextCapsuleV1 } from "./context-capsule";

import {
  canonicalContextCapsuleJson,
  ContextCapsuleContractError,
  parseContextCapsuleV1,
  type ContextCapsuleCreateOptions,
} from "./context-capsule";
import {
  canonicalVerifierJson,
  hasNoncanonicalVerifierText,
} from "./context-verifier-canonical";

export interface ContextVerifierTokenAuthority {
  countTokens?: ContextCapsuleCreateOptions["countTokens"];
  tokenizerFingerprint?: string | null;
}

export const rawCanonicalContextJson = (input: unknown): string => {
  try {
    return canonicalVerifierJson(input);
  } catch (cause) {
    throw new ContextCapsuleContractError(
      "invalid_input",
      "Context Capsule input must be canonical JSON",
      { cause }
    );
  }
};

export const parseCanonicalContextCapsuleForVerification = (
  input: unknown,
  authority: ContextVerifierTokenAuthority = {}
): ContextCapsuleV1 => {
  const rawInputBefore = rawCanonicalContextJson(input);
  if (hasNoncanonicalVerifierText(input)) {
    throw new ContextCapsuleContractError(
      "invalid_input",
      "Context Capsule input must already use NFC text and LF line endings"
    );
  }
  let capsule = parseContextCapsuleV1(input);
  if (capsule.budget.estimator === "active_tokenizer") {
    if (
      authority.countTokens === undefined ||
      authority.tokenizerFingerprint !== capsule.budget.tokenizerFingerprint
    ) {
      throw new ContextCapsuleContractError(
        "tokenizer_unavailable",
        "The Capsule's active tokenizer and matching fingerprint are required for verification"
      );
    }
    capsule = parseContextCapsuleV1(input, {
      countTokens: authority.countTokens,
    });
  }
  if (rawInputBefore !== canonicalContextCapsuleJson(capsule)) {
    throw new ContextCapsuleContractError(
      "invalid_input",
      "Context Capsule input must already use its canonical semantic representation"
    );
  }
  return capsule;
};
