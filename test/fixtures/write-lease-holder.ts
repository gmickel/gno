/**
 * Test fixture: hold the CLI write lease or the raw advisory lock until timeout.
 *
 * Usage:
 *   bun test/fixtures/write-lease-holder.ts <lease|lock> <dbPath> <holdMs> [command]
 */
import { acquireWriteLock } from "../../src/core/file-lock";
import {
  acquireCliWriteLease,
  writeLeasePath,
} from "../../src/core/write-lease";

const mode = process.argv[2];
const dbPath = process.argv[3];
const holdMs = Number(process.argv[4] ?? "2000");
const command = process.argv[5] ?? "gno index growth-factors";

if (!mode || !dbPath || !Number.isFinite(holdMs) || holdMs < 0) {
  process.stderr.write(
    "usage: write-lease-holder <lease|lock> <dbPath> <holdMs> [command]\n"
  );
  process.exit(2);
}

if (mode === "lease") {
  const result = await acquireCliWriteLease({
    dbPath,
    waitMs: 5_000,
    command,
  });
  if (!result.ok) {
    process.stderr.write("failed to acquire lease\n");
    process.exit(3);
  }
  process.stdout.write("ready\n");
  await Bun.sleep(holdMs);
  await result.release();
  process.exit(0);
}

if (mode === "lock") {
  const lock = await acquireWriteLock(writeLeasePath(dbPath), 5_000);
  if (!lock) {
    process.stderr.write("failed to acquire lock\n");
    process.exit(3);
  }
  process.stdout.write("ready\n");
  await Bun.sleep(holdMs);
  await lock.release();
  process.exit(0);
}

process.stderr.write(`unknown mode: ${mode}\n`);
process.exit(2);
