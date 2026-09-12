import { expect, test } from "bun:test";

import {
  chunkingPolicyKey,
  DEFAULT_CHUNKING_PARAMS,
  DEFAULT_CHUNKING_POLICY_KEY,
  MAX_CHUNK_TOKENS,
  resolveChunkingParams,
} from "../../src/config/chunking";
import { ConfigSchema } from "../../src/config/types";

test("omitted, partial and explicit defaults resolve to the existing policy", () => {
  for (const input of [
    undefined,
    {},
    { maxTokens: 800 },
    { overlapPercent: 0.15 },
    DEFAULT_CHUNKING_PARAMS,
  ]) {
    expect(resolveChunkingParams(input)).toEqual(DEFAULT_CHUNKING_PARAMS);
    expect(chunkingPolicyKey(resolveChunkingParams(input))).toBe(
      DEFAULT_CHUNKING_POLICY_KEY
    );
  }
  expect(ConfigSchema.parse({ version: "1.0" }).chunking).toBeUndefined();
  expect(
    ConfigSchema.parse({ version: "1.0", chunking: { maxTokens: 256 } })
      .chunking
  ).toEqual({ maxTokens: 256, overlapPercent: 0.15 });
});

test("supported boundaries and zero overlap remain explicit", () => {
  expect(resolveChunkingParams({ maxTokens: 10, overlapPercent: 0 })).toEqual({
    maxTokens: 10,
    overlapPercent: 0,
  });
  expect(
    resolveChunkingParams({ maxTokens: MAX_CHUNK_TOKENS, overlapPercent: 0.5 })
  ).toEqual({ maxTokens: MAX_CHUNK_TOKENS, overlapPercent: 0.5 });
});

test.each([
  0,
  -1,
  9,
  10.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER,
  "256",
  null,
])("rejects invalid maxTokens %p before config can be used", (maxTokens) => {
  expect(
    ConfigSchema.safeParse({ version: "1.0", chunking: { maxTokens } }).success
  ).toBe(false);
});

test.each([
  -0.1,
  0.51,
  1,
  15,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "0.15",
  null,
])(
  "rejects invalid overlapPercent %p rather than clamping",
  (overlapPercent) => {
    expect(
      ConfigSchema.safeParse({ version: "1.0", chunking: { overlapPercent } })
        .success
    ).toBe(false);
  }
);

test("rejects misspelled chunking controls", () => {
  expect(
    ConfigSchema.safeParse({ version: "1.0", chunking: { maxToken: 256 } })
      .success
  ).toBe(false);
});
