import { SqliteAdapter } from "../../src/store/sqlite/adapter";

const [, , dbPath, barrierPath] = Bun.argv;
if (!(dbPath && barrierPath)) {
  throw new Error("Expected database and barrier paths");
}

const adapter = new SqliteAdapter();
const opened = await adapter.open(dbPath, "unicode61");
if (!opened.ok) throw new Error(opened.error.message);

while (!(await Bun.file(barrierPath).exists())) {
  await Bun.sleep(2);
}

const result = await adapter.appendRetrievalTraceEvent({
  eventId: "concurrent-event",
  traceId: "concurrent-trace",
  runId: null,
  idempotencyKey: "same-event",
  kind: "query",
  payload: { status: "received" },
  createdAtMs: 1_000,
});
await adapter.close();
await Bun.write(Bun.stdout, JSON.stringify(result));
