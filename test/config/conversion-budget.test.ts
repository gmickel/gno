import { describe, expect, test } from "bun:test";

import { ConfigSchema } from "../../src/config/types";
import { withContentTypeRules } from "../../src/ingestion/sync-options";

const parseConversion = (conversion: unknown) =>
  ConfigSchema.safeParse({ version: "1.0", conversion });

describe("conversion budget config (fn-198)", () => {
  test.each([
    { conversion: {}, ok: true },
    { conversion: { timeoutMs: 1000, maxMemoryMb: 256 }, ok: true },
    { conversion: { timeoutMs: 999 }, ok: false },
    { conversion: { maxMemoryMb: 255 }, ok: false },
    { conversion: { timeoutMs: 1500.5 }, ok: false },
    { conversion: { unknown: 1 }, ok: false },
  ])("$conversion parses: $ok", ({ conversion, ok }) => {
    expect(parseConversion(conversion).success).toBe(ok);
  });

  test("reaches sync limits, with explicit per-call limits winning", () => {
    const config = { conversion: { timeoutMs: 120_000, maxMemoryMb: 4096 } };

    expect(withContentTypeRules({}, config).limits).toEqual({
      timeoutMs: 120_000,
      maxMemoryMb: 4096,
    });
    expect(
      withContentTypeRules({ limits: { timeoutMs: 5000 } }, config).limits
    ).toEqual({ timeoutMs: 5000, maxMemoryMb: 4096 });
    expect(withContentTypeRules({}, {}).limits).toBeUndefined();
  });
});
