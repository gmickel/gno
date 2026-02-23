import { describe, expect, test } from "bun:test";

import {
  isWithinTemporalRange,
  resolveRecencyTimestamp,
  resolveTemporalRange,
  shouldSortByRecency,
} from "../../src/pipeline/temporal";

const NOW = new Date("2026-02-23T12:00:00.000Z");

describe("temporal range resolution", () => {
  test("parses explicit date-only flags to day boundaries", () => {
    const range = resolveTemporalRange(
      "query",
      "2026-02-01",
      "2026-02-10",
      NOW
    );
    expect(range.since).toBe("2026-02-01T00:00:00.000Z");
    expect(range.until).toBe("2026-02-10T23:59:59.999Z");
  });

  test("infers this week from query text", () => {
    const range = resolveTemporalRange(
      "documents from this week",
      undefined,
      undefined,
      NOW
    );
    expect(range.since).toBe("2026-02-23T00:00:00.000Z");
    expect(range.until).toBe("2026-02-23T12:00:00.000Z");
  });

  test("explicit flags override query inference", () => {
    const range = resolveTemporalRange(
      "documents from this week",
      "2026-01-01",
      undefined,
      NOW
    );
    expect(range.since).toBe("2026-01-01T00:00:00.000Z");
    expect(range.until).toBeUndefined();
  });
});

describe("temporal range matching", () => {
  test("accepts values within bounds and rejects outside", () => {
    const range = {
      since: "2026-02-10T00:00:00.000Z",
      until: "2026-02-20T23:59:59.999Z",
    };

    expect(isWithinTemporalRange("2026-02-15T10:00:00.000Z", range)).toBe(true);
    expect(isWithinTemporalRange("2026-02-09T23:59:59.000Z", range)).toBe(
      false
    );
    expect(isWithinTemporalRange("2026-02-21T00:00:00.000Z", range)).toBe(
      false
    );
  });
});

describe("temporal recency sort intent", () => {
  test("detects recency sort phrases", () => {
    expect(shouldSortByRecency("latest meeting notes")).toBe(true);
    expect(shouldSortByRecency("show most recent updates")).toBe(true);
    expect(shouldSortByRecency("database auth design")).toBe(false);
  });

  test("prefers doc date and falls back to modified time", () => {
    expect(
      resolveRecencyTimestamp(
        "2026-02-10T00:00:00.000Z",
        "2026-02-01T00:00:00.000Z"
      )
    ).toBe(new Date("2026-02-10T00:00:00.000Z").getTime());

    expect(resolveRecencyTimestamp(undefined, "2026-02-01T00:00:00.000Z")).toBe(
      new Date("2026-02-01T00:00:00.000Z").getTime()
    );
  });
});
