import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:path has no Bun path utility equivalent.
import { join } from "node:path";

import { createDefaultConfig } from "../../src/config";
import {
  createReplayTestHarness,
  type ReplayTestHarness,
} from "../replay/retrieval-replay-fixture";

describe("private retrieval trace local-only contract", () => {
  let harness: ReplayTestHarness;

  beforeEach(async () => {
    harness = await createReplayTestHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  test("records labels exports replays and purges without network or mutation", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("Retrieval trace lifecycle attempted network access");
    }) as unknown as typeof fetch;
    try {
      const userFile = join(harness.root, "user-owned.md");
      await Bun.write(userFile, "user-owned source remains unchanged\n");
      const sourceBefore = await Bun.file(userFile).text();
      const config = createDefaultConfig();
      const configBefore = JSON.stringify(config);
      const { service, exportId } = await harness.buildReceipt();
      const traceBefore = await harness.store.getRetrievalTrace("replay-trace");

      const replayed = await service.replay(
        {
          exportId,
          candidate: { id: "privacy-bm25", type: "bm25", limit: 5 },
        },
        {
          config,
          vectorIndex: null,
          embedPort: null,
          expandPort: null,
          rerankPort: null,
          indexName: "default",
        }
      );
      expect(replayed.ok).toBeTrue();
      if (!replayed.ok) return;
      expect(replayed.value.applied).toBeFalse();
      expect(await harness.store.getRetrievalTrace("replay-trace")).toEqual(
        traceBefore
      );
      expect(JSON.stringify(config)).toBe(configBefore);
      expect(await Bun.file(userFile).text()).toBe(sourceBefore);

      const deleted = await service.delete("replay-trace");
      expect(deleted.ok && deleted.value.counts).toMatchObject({
        traces: 1,
        runs: 1,
        judgments: 2,
        exports: 1,
        exportLinks: 1,
      });
      const purged = await service.purge();
      expect(purged.ok && purged.value.traces).toBe(0);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
