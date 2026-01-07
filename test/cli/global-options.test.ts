/**
 * Tests for global options parsing.
 * Table-driven tests for offline flag and env var handling.
 */

import { describe, expect, test } from "bun:test";

import { parseGlobalOptions } from "../../src/cli/context";

describe("parseGlobalOptions", () => {
  describe("offline mode", () => {
    // Table-driven test cases for offline handling
    const cases: [
      string,
      Record<string, unknown>,
      Record<string, string | undefined>,
      boolean,
    ][] = [
      // Default
      ["default (no flag, no env)", {}, {}, false],

      // --offline flag
      ["--offline flag", { offline: true }, {}, true],
      ["--offline explicitly false", { offline: false }, {}, false],

      // HF_HUB_OFFLINE env var
      ["HF_HUB_OFFLINE=1", {}, { HF_HUB_OFFLINE: "1" }, true],
      ['HF_HUB_OFFLINE="" (empty)', {}, { HF_HUB_OFFLINE: "" }, false],
      ["HF_HUB_OFFLINE undefined", {}, {}, false],

      // GNO_OFFLINE env var (alternative)
      ["GNO_OFFLINE=1", {}, { GNO_OFFLINE: "1" }, true],
      ['GNO_OFFLINE="" (empty)', {}, { GNO_OFFLINE: "" }, false],

      // Combinations
      [
        "--offline + HF_HUB_OFFLINE=1",
        { offline: true },
        { HF_HUB_OFFLINE: "1" },
        true,
      ],
      [
        "flag false + HF_HUB_OFFLINE=1 -> env wins",
        { offline: false },
        { HF_HUB_OFFLINE: "1" },
        true,
      ],
    ];

    for (const [description, raw, env, expectedOffline] of cases) {
      test(description, () => {
        const result = parseGlobalOptions(raw, env);
        expect(result.offline).toBe(expectedOffline);
      });
    }
  });

  describe("other options", () => {
    test("parses all global options", () => {
      const result = parseGlobalOptions(
        {
          index: "custom",
          config: "/path/to/config.yml",
          color: true,
          verbose: true,
          yes: true,
          quiet: true,
          json: true,
          offline: true,
        },
        {}
      );

      expect(result).toEqual({
        index: "custom",
        config: "/path/to/config.yml",
        color: true,
        verbose: true,
        yes: true,
        quiet: true,
        json: true,
        offline: true,
        noPager: false,
      });
    });

    test("uses defaults for missing options", () => {
      const result = parseGlobalOptions({}, {});

      expect(result).toEqual({
        index: "default",
        config: undefined,
        color: true,
        verbose: false,
        yes: false,
        quiet: false,
        json: false,
        offline: false,
        noPager: false,
      });
    });

    test("NO_COLOR env disables color", () => {
      const result = parseGlobalOptions({}, { NO_COLOR: "1" });
      expect(result.color).toBe(false);
    });

    test("--no-color flag disables color", () => {
      const result = parseGlobalOptions({ color: false });
      expect(result.color).toBe(false);
    });

    test("NO_PAGER env disables pager", () => {
      const result = parseGlobalOptions({}, { NO_PAGER: "1" });
      expect(result.noPager).toBe(true);
    });

    test("GNO_NO_PAGER env disables pager", () => {
      const result = parseGlobalOptions({}, { GNO_NO_PAGER: "1" });
      expect(result.noPager).toBe(true);
    });
  });
});
