import { expect, test } from "bun:test";

import { writeOutcomeUnknown } from "../../../../src/serve/public/lib/request-intent";

test.each([
  ["server error", 500, "RUNTIME", true],
  ["request still pending", 409, "REQUEST_PENDING", true],
  ["conflict", 409, "CONFLICT", false],
  ["lease busy", 409, "LOCKED", false],
] as const)("write outcome after %s", (_name, status, code, unknown) => {
  expect(writeOutcomeUnknown(status, code)).toBe(unknown);
});
