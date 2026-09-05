// Real synthetic SyncService timings; never an attribution for private-vault elapsed time.
import { mkdir } from "node:fs/promises"; // Bun has no directory creation API.
const frozen = "/home/gordon/.cache/agent-tmp/gno-fn150-qa/source";
const root = "/home/gordon/.cache/agent-tmp/gno-fn150-qa/scaling";
const output =
  "/home/gordon/work/gno/.flow/artifacts/fn-150-incremental-graph-reconciliation-with/scaling.json";
const { SqliteAdapter } = await import(frozen + "/src/store/sqlite/adapter.ts");
const { SyncService } = await import(frozen + "/src/ingestion/index.ts");
const { sizes } = await import(
  frozen + "/evals/fixtures/acceptance/graph-reconciliation/fixture.ts"
);
const results = [];
for (const size of sizes) {
  const where = root + "/" + size;
  await mkdir(where, { recursive: true });
  const collections = ["targets", "outside"].map((name) => ({
    name,
    path: where + "/" + name,
    pattern: "**/*.md",
    include: [],
    exclude: [],
  }));
  for (const c of collections) await mkdir(c.path, { recursive: true });
  const fixtureHasher = new Bun.CryptoHasher("sha256");
  const write = async (path: string, body: string) => {
    fixtureHasher.update(path + "\0" + body);
    await Bun.write(where + "/" + path, body);
  };
  await write("targets/opaque.md", "# Anchor\n");
  const source = (index: number, broad = false) =>
    '---\nrelations:\n  knows: ["targets:' +
    (broad ? "Different" : "Anchor") +
    '"]\n---\n# Source ' +
    index +
    (broad ? " changed" : "") +
    "\n";
  for (let i = 1; i < size; i++)
    await write("outside/source-" + i + ".md", source(i));
  const store = new SqliteAdapter();
  await store.open(where + "/index.sqlite", "porter");
  await store.syncCollections(collections);
  const service = new SyncService();
  const initial = await service.syncAll(collections, store);
  if (initial.collections.some((c: { errors: unknown[] }) => c.errors.length))
    throw new Error(JSON.stringify(initial));
  const db = store.getRawDb();
  db.exec(`CREATE TEMP TABLE qa_graph_counts(operation TEXT);
    CREATE TEMP TRIGGER qa_graph_insert AFTER INSERT ON doc_edges BEGIN INSERT INTO qa_graph_counts VALUES('insert'); END;
    CREATE TEMP TRIGGER qa_graph_delete AFTER DELETE ON doc_edges BEGIN INSERT INTO qa_graph_counts VALUES('delete'); END;
    CREATE TEMP TRIGGER qa_graph_update AFTER UPDATE ON doc_edges BEGIN INSERT INTO qa_graph_counts VALUES('update'); END;`);
  let reads = 0;
  const read = store.getContent.bind(store);
  store.getContent = (hash: string) => {
    reads++;
    return read(hash);
  };
  for (const phase of ["noop", "narrow", "broad"]) {
    if (phase === "narrow") await write("targets/opaque.md", "# Different\n");
    if (phase === "broad")
      for (let i = 1; i < size; i++)
        await write("outside/source-" + i + ".md", source(i, true));
    reads = 0;
    db.run("DELETE FROM qa_graph_counts");
    const start = performance.now();
    const sync =
      phase === "broad"
        ? await service.syncAll(collections, store)
        : await service.syncCollection(collections[0], store);
    const durationMs = performance.now() - start;
    const counts = db
      .query(
        "SELECT operation,count(*) AS count FROM qa_graph_counts GROUP BY operation ORDER BY operation"
      )
      .all();
    const edges = db
      .query("SELECT count(*) AS count FROM doc_edges")
      .get().count;
    const projection = db
      .query("SELECT dirty,in_progress FROM graph_projection_state")
      .get();
    results.push({
      size,
      phase,
      durationMs,
      contentReads: reads,
      counts,
      edges,
      projection,
      sync,
    });
    await Bun.write(
      output,
      JSON.stringify(
        {
          commit: "dd38f777",
          runtime: Bun.version,
          platform: process.platform,
          arch: process.arch,
          measurement:
            "one real synthetic sync per case; no model ports, no private corpus",
          results,
        },
        null,
        2
      )
    );
    console.log(
      JSON.stringify({ size, phase, durationMs, reads, counts, edges })
    );
  }
  await Bun.write(where + "/fixture.sha256", fixtureHasher.digest("hex"));
  await store.close();
}
