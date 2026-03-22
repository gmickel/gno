import { describe, expect, test } from "bun:test";

import { getEventStreamRetryDelay } from "../../../../src/serve/public/hooks/use-doc-events";

describe("use-doc-events retry policy", () => {
  test("backs off exponentially and caps delay", () => {
    expect(getEventStreamRetryDelay(0)).toBe(1000);
    expect(getEventStreamRetryDelay(1)).toBe(2000);
    expect(getEventStreamRetryDelay(2)).toBe(4000);
    expect(getEventStreamRetryDelay(4)).toBe(10000);
    expect(getEventStreamRetryDelay(8)).toBe(10000);
  });
});
