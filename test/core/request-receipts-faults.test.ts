/**
 * Deterministic fault injection across every scoped mutation (fn-170 R4/R7):
 * an attempt "crashes" at each request boundary, the caller retries the same
 * request ID from a new session, and the durable side effects on disk are
 * counted. One admitted request yields exactly one side effect and a stable
 * replay.
 */

import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises mkdtemp: temp fixture root, no Bun equivalent
import { mkdtemp } from "node:fs/promises";
// node:os tmpdir: no Bun equivalent
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { RequestCheckpoint } from "../../src/core/request-receipts";

import { MEMORY_SUPERSEDES_EDGE } from "../../src/core/memory-record";
import { safeRm } from "../helpers/cleanup";
import {
  openReceiptHarness,
  publishedFile,
  type ReceiptHarness,
  readSideEffects,
  runOp,
  SCOPED_OPS,
  seedOp,
} from "../helpers/request-receipts";

const STAGES: RequestCheckpoint[] = [
  "prepared",
  "admitted",
  "published",
  "synced",
  "committed",
];
const PUBLISHED_STAGES = new Set<RequestCheckpoint>([
  "published",
  "synced",
  "committed",
]);

const harnesses: ReceiptHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.store.close();
    await safeRm(h.root);
  }
});

async function harness(): Promise<ReceiptHarness> {
  const h = await openReceiptHarness(
    await mkdtemp(join(tmpdir(), "gno-receipt-fault-"))
  );
  harnesses.push(h);
  return h;
}

describe("request receipts under injected crashes", () => {
  for (const op of SCOPED_OPS) {
    for (const stage of STAGES) {
      test(`${op}: crash at ${stage}, retry, replay`, async () => {
        const h = await harness();
        const seed = await seedOp(h, op);
        const crash = (at: RequestCheckpoint) => {
          if (at === stage) throw new Error("simulated crash");
        };

        const crashed = await runOp(h, op, {
          requestId: "req-1",
          seed,
          checkpoint: crash,
        });
        expect(crashed.ok).toBe(false);
        const afterCrash = await readSideEffects(h, op);
        expect(afterCrash.writes).toBe(PUBLISHED_STAGES.has(stage) ? 1 : 0);

        // Retry from a new session: transport identity is not intent.
        const retried = await runOp(h, op, {
          requestId: "req-1",
          seed,
          session: "session-after-reconnect",
        });
        expect(retried).toMatchObject({
          ok: true,
          replayed: stage === "committed",
        });
        const afterRetry = await readSideEffects(h, op);
        expect(afterRetry.writes).toBe(1);
        if (PUBLISHED_STAGES.has(stage)) {
          // A published document update is finished, never rewritten.
          expect(afterRetry.fileId).toBe(afterCrash.fileId);
        }

        const replayed = await runOp(h, op, { requestId: "req-1", seed });
        expect(replayed).toMatchObject({
          ok: true,
          replayed: true,
          ref: retried.ref,
        });
        expect(await readSideEffects(h, op)).toEqual(afterRetry);

        if (op === "remember-supersede") {
          const predecessor = await h.store.getDocumentByUri(
            seed.predecessorUri ?? ""
          );
          const successors = await h.store.getEdgeBacklinksForDoc(
            predecessor.ok && predecessor.value ? predecessor.value.id : -1,
            { edgeType: MEMORY_SUPERSEDES_EDGE }
          );
          expect(successors.ok && successors.value.length).toBe(1);
        } else if (op !== "document-update") {
          const indexed = await h.store.getDocumentByUri(retried.ref ?? "");
          expect(indexed.ok && indexed.value?.active).toBe(true);
        }
      });
    }
  }
});

describe("recovery never overwrites a changed target", () => {
  for (const op of SCOPED_OPS) {
    test(`${op}: a file edited after an interrupted publication is left alone`, async () => {
      const h = await harness();
      const seed = await seedOp(h, op);
      await runOp(h, op, {
        requestId: "req-1",
        seed,
        checkpoint: (at) => {
          if (at === "published") throw new Error("simulated crash");
        },
      });
      const path = await publishedFile(h, op, seed);
      await Bun.write(path, "local edit made after the crash\n");

      const retried = await runOp(h, op, { requestId: "req-1", seed });
      expect(retried).toMatchObject({
        ok: false,
        code: "REQUEST_RECOVERY_CONFLICT",
      });
      expect(await Bun.file(path).text()).toBe(
        "local edit made after the crash\n"
      );
    });
  }
});
