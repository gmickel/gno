/**
 * Child process for fn-170 crash/concurrency tests: run one scoped mutation
 * against a shared temp index and print its outcome as JSON. With a crash
 * stage the process SIGKILLs itself at that request boundary.
 *
 * argv: <root> <op> <requestId> <crashStage|-> [variant]
 */

// node:path has no Bun path utilities
import { join } from "node:path";

import type { RequestCheckpoint } from "../../../src/core/request-receipts";

import {
  type OpSeed,
  openReceiptHarness,
  runOp,
  type ScopedOp,
} from "../../helpers/request-receipts";

const [root, op, requestId, crashStage, variant] = Bun.argv.slice(2);
if (!root || !op || !requestId || !crashStage) {
  throw new Error(
    "usage: run-op.ts <root> <op> <requestId> <crashStage|-> [variant]"
  );
}
const harness = await openReceiptHarness(root, { registerCollections: false });
const seed = (await Bun.file(join(root, "seed.json")).json()) as OpSeed;
const outcome = await runOp(harness, op as ScopedOp, {
  requestId,
  seed,
  variant: variant || undefined,
  session: `pid:${process.pid}`,
  checkpoint:
    crashStage === "-"
      ? undefined
      : (stage: RequestCheckpoint) => {
          if (stage === crashStage) process.kill(process.pid, "SIGKILL");
        },
});
await harness.store.close();
process.stdout.write(`${JSON.stringify(outcome)}\n`);
