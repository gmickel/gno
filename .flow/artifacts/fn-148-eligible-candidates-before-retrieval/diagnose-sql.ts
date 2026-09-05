import { Database } from "bun:sqlite";

const root = ".flow/artifacts/fn-148-eligible-candidates-before-retrieval";
const prior = await Bun.file(`${root}/wire-normalized-known-vectors/report.json`).json();
const diagnostics: unknown[] = [];
for (const corpus of prior.corpora) {
  const db = new Database(`${corpus.directory}/index.sqlite`, { readonly: true });
  try {
    for (const selective of [false, true]) {
      const owner = `SELECT d.id, d.mirror_hash FROM documents d WHERE d.active = 1 ${selective ? "AND EXISTS (SELECT 1 FROM doc_tags t WHERE t.document_id=d.id AND t.tag='rare')" : ""}`;
      const predicates = {
        pre1482Broad: "rowid IN (SELECT id FROM documents WHERE active = 1)",
        current: `rowid IN (SELECT id FROM (${owner}))`,
        proposed: `EXISTS (SELECT 1 FROM (${owner}) eligible WHERE eligible.id = documents_fts.rowid)`,
      };
      const outputs = new Map<string, string>();
      for (const [variant, predicate] of Object.entries(predicates)) {
        if (selective && variant === "pre1482Broad") continue;
        // Exact searchFts hot CTE and owner join; unused output metadata omitted.
        const sql = `WITH fts_matches AS (
          SELECT rowid, snippet(documents_fts, 2, '<mark>', '</mark>', '...', 32) AS snippet,
                 bm25(documents_fts, 1.5, 4, 1) AS score
          FROM documents_fts WHERE documents_fts MATCH ? AND ${predicate}
          ORDER BY score LIMIT ?
        ) SELECT fm.rowid, d.uri, fm.score, fm.snippet FROM fts_matches fm
          JOIN documents d ON d.id=fm.rowid AND d.active=1
          WHERE 1=1 ORDER BY fm.score LIMIT ?`;
        const params = ["needle*", 10, 10];
        const start = performance.now();
        const rows = db.query(sql).all(...params);
        const elapsedMs = performance.now() - start;
        const serialized = JSON.stringify(rows);
        outputs.set(variant, serialized);
        diagnostics.push({ size: corpus.size, selective, variant, sql, params, elapsedMs, rows, plan: db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params), sameAsCurrent: variant === "proposed" ? serialized === outputs.get("current") : null });
        await Bun.write(`${root}/sql-diagnosis.json`, JSON.stringify({ baselineSource: "cb3421f6:src/store/sqlite/adapter.ts searchFts broad active-only CTE", candidateSource: prior.commit, caveat: "Diagnostic hot SQL, not an old-revision end-to-end latency baseline; only unused outer metadata columns omitted. One timing per variant, cache already warm. Exact URI/score/snippet ordered equality tested.", diagnostics }, null, 2));
        console.info(corpus.size, selective, variant, elapsedMs, rows.length);
      }
      if (outputs.get("current") !== outputs.get("proposed")) throw new Error("EXISTS changed ordered output");
      if (!selective && outputs.get("pre1482Broad") !== outputs.get("current")) throw new Error("Pre1482 broad query differs");
    }
  } finally { db.close(); }
}
