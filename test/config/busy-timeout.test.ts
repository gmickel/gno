import { describe, expect, test } from "bun:test";
// node:fs/promises provides temporary directory cleanup; Bun has no directory removal API.
import { mkdtemp, rm } from "node:fs/promises";
// node:os tmpdir and node:path join have no Bun equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigFromPath } from "../../src/config/loader";
import {
  ConfigSchema,
  DEFAULT_BUSY_TIMEOUT_MS,
  MAX_BUSY_TIMEOUT_MS,
  MIN_BUSY_TIMEOUT_MS,
} from "../../src/config/types";

const RANGE_MESSAGE =
  "busyTimeoutMs must be an integer between 1000 and 600000";

function parseBusyTimeout(value: unknown) {
  return ConfigSchema.safeParse({
    version: "1.0",
    busyTimeoutMs: value,
  });
}

describe("busyTimeoutMs config", () => {
  test("accepts the documented default and range bounds", () => {
    expect(parseBusyTimeout(DEFAULT_BUSY_TIMEOUT_MS).success).toBe(true);
    expect(parseBusyTimeout(MIN_BUSY_TIMEOUT_MS).success).toBe(true);
    expect(parseBusyTimeout(MAX_BUSY_TIMEOUT_MS).success).toBe(true);
  });

  test("applies the documented default when omitted", () => {
    const result = ConfigSchema.safeParse({ version: "1.0" });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.busyTimeoutMs).toBe(DEFAULT_BUSY_TIMEOUT_MS);
  });

  test("rejects out-of-range values with a message naming the field and range", () => {
    for (const value of [999, 600_001, 1.5, 0]) {
      const result = parseBusyTimeout(value);
      expect(result.success).toBe(false);
      if (result.success) {
        return;
      }
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.some((message) => message.includes(RANGE_MESSAGE))).toBe(
        true
      );
    }
  });

  test("rejects out-of-range values at config load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gno-busy-timeout-config-"));
    const path = join(dir, "config.yml");
    try {
      await Bun.write(
        path,
        `version: "1.0"
busyTimeoutMs: 500
`
      );
      const result = await loadConfigFromPath(path);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error.code).toBe("VALIDATION_ERROR");
      if (result.error.code !== "VALIDATION_ERROR") {
        return;
      }
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.some((message) => message.includes(RANGE_MESSAGE))).toBe(
        true
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("loads an in-range configured value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gno-busy-timeout-valid-"));
    const path = join(dir, "config.yml");
    try {
      await Bun.write(
        path,
        `version: "1.0"
busyTimeoutMs: 120000
`
      );
      const result = await loadConfigFromPath(path);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.busyTimeoutMs).toBe(120_000);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
