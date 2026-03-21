import { describe, expect, test } from "bun:test";

import {
  DEFAULT_THOROUGH_CANDIDATE_LIMIT,
  balancedUsesExpansion,
  resolveDepthPolicy,
} from "../../src/core/depth-policy";

describe("depth policy", () => {
  test("balanced enables expansion for slim presets", () => {
    expect(balancedUsesExpansion("slim")).toBe(true);
    expect(balancedUsesExpansion("slim-tuned")).toBe(true);
    expect(resolveDepthPolicy({ presetId: "slim" }).noExpand).toBe(false);
    expect(resolveDepthPolicy({ presetId: "slim-tuned" }).noExpand).toBe(false);
  });

  test("balanced keeps expansion off for non-slim presets", () => {
    const policy = resolveDepthPolicy({ presetId: "quality" });
    expect(policy.noExpand).toBe(true);
    expect(policy.noRerank).toBe(false);
  });

  test("thorough widens candidate limit by default", () => {
    const policy = resolveDepthPolicy({
      presetId: "slim",
      thorough: true,
    });
    expect(policy.noExpand).toBe(false);
    expect(policy.noRerank).toBe(false);
    expect(policy.candidateLimit).toBe(DEFAULT_THOROUGH_CANDIDATE_LIMIT);
  });

  test("structured modes suppress generated expansion", () => {
    const policy = resolveDepthPolicy({
      presetId: "slim",
      hasStructuredModes: true,
    });
    expect(policy.noExpand).toBe(true);
    expect(policy.noRerank).toBe(false);
  });
});
