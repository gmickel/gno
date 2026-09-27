/**
 * Fixture (fn-198): a process with its own graceful `once("SIGTERM")`
 * shutdown, like serve and daemon, that is indexing a slow file with the
 * child file processor. Prints `CHILD <pid>` once the child is working, and
 * `GRACEFUL_STARTED` / `GRACEFUL_FINISHED` around an async cleanup that
 * exits with code 7.
 *
 * Usage: bun graceful-sigterm-parent.ts <collection-dir> <db-path>
 */

import type { Collection } from "../../../src/config/types";

import {
  activeFileProcessorPid,
  useFileProcessorBackend,
} from "../../../src/ingestion/file-processor";
import { SyncService } from "../../../src/ingestion/sync";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";

const [root, dbPath] = process.argv.slice(2) as [string, string];
const GRACEFUL_EXIT_CODE = 7;

process.once("SIGTERM", async () => {
  process.stdout.write("GRACEFUL_STARTED\n");
  await Bun.sleep(300);
  process.stdout.write("GRACEFUL_FINISHED\n");
  process.exit(GRACEFUL_EXIT_CODE);
});

useFileProcessorBackend("child");
const adapter = new SqliteAdapter();
await adapter.open(dbPath, "porter");
const collection: Collection = {
  name: "docs",
  path: root,
  pattern: "**/*",
  include: [],
  exclude: [],
};
await adapter.syncCollections([collection]);
void new SyncService().syncCollection(collection, adapter, {
  limits: { timeoutMs: 60_000 },
});
for (;;) {
  const pid = activeFileProcessorPid();
  if (pid !== null) {
    process.stdout.write(`CHILD ${pid}\n`);
    break;
  }
  await Bun.sleep(25);
}
await Bun.sleep(60_000);
