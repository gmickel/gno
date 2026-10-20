/**
 * With collection access unset (no request principal), every scoped tool
 * answers byte-for-byte as upstream GNO does, on a corpus that exercises
 * everything access mode changes (test/fixtures/mcp/access-unset-parity-context.ts).
 *
 * test/fixtures/mcp/access-unset-parity.json is a frozen capture of the same
 * calls on upstream main (5379fde4), never regenerated from this tree: copy
 * the context file into an upstream checkout and write the JSON of
 * `captureUnsetAccessResponses()` there. A missing golden fails the test.
 */

import { expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { captureUnsetAccessResponses } from "../fixtures/mcp/access-unset-parity-context";

const GOLDEN_PATH = join(
  dirname(import.meta.dir),
  "fixtures",
  "mcp",
  "access-unset-parity.json"
);

test("access unset: responses match the upstream capture byte for byte", async () => {
  const golden = (await Bun.file(GOLDEN_PATH).json()) as Record<string, string>;
  const responses = await captureUnsetAccessResponses();
  expect(Object.keys(responses)).toEqual(Object.keys(golden));
  for (const [name, response] of Object.entries(responses)) {
    expect({ name, response }).toEqual({
      name,
      response: golden[name] as string,
    });
  }
});
