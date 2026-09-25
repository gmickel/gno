/**
 * Separate-process evidence for fn-170 R7: a writer SIGKILLed at a request
 * boundary is recovered by a later process, and concurrent processes
 * submitting one request ID converge on one durable side effect.
 */

import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises mkdtemp/unlink: fixture structure ops, no Bun equivalent
import { mkdtemp, unlink } from "node:fs/promises";
// node:os tmpdir: no Bun equivalent
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import { safeRm } from "../helpers/cleanup";
import {
  KILL_MARKER,
  type OpOutcome,
  openReceiptHarness,
  readSideEffects,
  SCOPED_OPS,
  type ScopedOp,
  seedOp,
} from "../helpers/request-receipts";

const CHILD = join(
  import.meta.dir,
  "..",
  "fixtures",
  "request-receipts",
  "run-op.ts"
);
const CONCURRENT_CALLERS = 3;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await safeRm(root);
});

async function seededRoot(op: ScopedOp): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gno-receipt-proc-"));
  roots.push(root);
  const h = await openReceiptHarness(root);
  await Bun.write(join(root, "seed.json"), JSON.stringify(await seedOp(h, op)));
  await h.store.close();
  return root;
}

async function child(
  root: string,
  op: ScopedOp,
  crashStage = "-",
  variant = ""
): Promise<{ killed: boolean; outcome: OpOutcome | null }> {
  const proc = Bun.spawn(
    [process.execPath, CHILD, root, op, "req-proc", crashStage, variant],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Kill exit codes differ by platform (137 on Unix, 1 on Windows); only the
  // fixture's marker distinguishes the deliberate kill from a real failure.
  const marker = join(root, KILL_MARKER);
  const killed = await Bun.file(marker).exists();
  if (killed) await unlink(marker);
  if (exitCode !== 0 && !killed) {
    throw new Error(`child failed (${exitCode}): ${stderr}`);
  }
  const line = stdout.trim().split("\n").pop();
  return {
    killed: killed && exitCode !== 0,
    outcome: line ? (JSON.parse(line) as OpOutcome) : null,
  };
}

async function effects(root: string, op: ScopedOp) {
  const h = await openReceiptHarness(root, { registerCollections: false });
  try {
    return await readSideEffects(h, op);
  } finally {
    await h.store.close();
  }
}

describe("request receipts across processes", () => {
  for (const op of SCOPED_OPS) {
    test(`${op}: a writer killed after publication is finished by the next process`, async () => {
      const root = await seededRoot(op);
      const killed = await child(root, op, "published");
      expect(killed).toEqual({ killed: true, outcome: null });
      const afterKill = await effects(root, op);
      expect(afterKill.writes).toBe(1);

      const recovered = await child(root, op);
      expect(recovered.outcome).toMatchObject({ ok: true, replayed: false });
      const replayed = await child(root, op);
      expect(replayed.outcome).toMatchObject({
        ok: true,
        replayed: true,
        ref: recovered.outcome?.ref,
      });
      expect(await effects(root, op)).toEqual(afterKill);
    }, 30_000);

    test(`${op}: concurrent callers with one request ID converge`, async () => {
      const root = await seededRoot(op);
      const results = await Promise.all([
        ...Array.from({ length: CONCURRENT_CALLERS }, () => child(root, op)),
        child(root, op, "-", "different payload"),
      ]);
      const outcomes = results.map((result) => result.outcome);
      const winners = outcomes.filter((outcome) => outcome?.ok);
      const losers = outcomes.filter((outcome) => !outcome?.ok);
      // Whichever payload was admitted first owns the ID: its callers share
      // one outcome (one executed, the rest replayed); the other conflicts.
      expect(new Set(winners.map((outcome) => outcome?.ref)).size).toBe(1);
      expect(winners.filter((outcome) => !outcome?.replayed)).toHaveLength(1);
      expect(losers).toHaveLength(outcomes.at(-1)?.ok ? CONCURRENT_CALLERS : 1);
      for (const loser of losers) {
        expect(loser?.code).toBe("REQUEST_ID_CONFLICT");
      }
      expect((await effects(root, op)).writes).toBe(1);
    }, 30_000);
  }
});
