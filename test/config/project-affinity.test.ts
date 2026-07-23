import { describe, expect, test } from "bun:test";

import { createDefaultConfig } from "../../src/config/defaults";
import {
  ConfigSchema,
  PROJECT_AFFINITY_MAX_CONTRIBUTION,
} from "../../src/config/types";

describe("project affinity config", () => {
  test("defaults to the frozen enabled contribution", () => {
    expect(createDefaultConfig().projectAffinity).toEqual({
      enabled: true,
      contribution: PROJECT_AFFINITY_MAX_CONTRIBUTION,
    });
  });

  test("accepts the maximum and rejects larger or negative contributions", () => {
    expect(
      ConfigSchema.safeParse({
        version: "1.0",
        projectAffinity: { enabled: true, contribution: 0.03 },
      }).success
    ).toBe(true);
    expect(
      ConfigSchema.safeParse({
        version: "1.0",
        projectAffinity: { enabled: true, contribution: 0.030_001 },
      }).success
    ).toBe(false);
    expect(
      ConfigSchema.safeParse({
        version: "1.0",
        projectAffinity: { enabled: true, contribution: -0.01 },
      }).success
    ).toBe(false);
  });
});
