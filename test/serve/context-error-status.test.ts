import { describe, expect, test } from "bun:test";

import {
  CONTEXT_REST_ERROR_STATUS,
  contextRestStatusForCode,
  type ContextRestErrorCode,
} from "../../src/serve/context-capsule";

const expected = {
  invalid_goal: 400,
  invalid_budget: 400,
  invalid_filter: 400,
  invalid_uri: 400,
  invalid_input: 400,
  identity_mismatch: 400,
  no_evidence: 404,
  tokenizer_unavailable: 503,
  chunk_coordinate_mismatch: 409,
  stored_provenance_mismatch: 409,
  index_snapshot_mismatch: 409,
  index_changed_during_compile: 409,
  context_changed_during_compile: 409,
  capsule_mutated_during_verify: 409,
  context_changed_during_verify: 409,
  index_changed_during_verify: 409,
  retrieval_failed: 500,
  chunk_load_failed: 500,
  collection_load_failed: 500,
  content_load_failed: 500,
  context_load_failed: 500,
  document_load_failed: 500,
  index_snapshot_failed: 500,
  runtime_error: 500,
} as const satisfies Record<ContextRestErrorCode, number>;

describe("Context Capsule REST error status contract", () => {
  test.each(Object.entries(expected))("maps %s to %i", (code, status) => {
    expect(contextRestStatusForCode(code)).toBe(status);
  });

  test("keeps the public map exhaustive and fails closed for unknown codes", () => {
    expect(CONTEXT_REST_ERROR_STATUS).toEqual(expected);
    expect(contextRestStatusForCode("future_unclassified_error")).toBe(500);
  });
});
