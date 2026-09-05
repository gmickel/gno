import { reader, embedPort, must } from "../../../../evals/acceptance/eligible-variant-fixture";
import { searchHybrid } from "../../../../src/pipeline/hybrid";
import { searchVectorWithEmbedding } from "../../../../src/pipeline/vsearch";
import type { Config } from "../../../../src/config/types";
const root = ".flow/artifacts/fn-148-eligible-candidates-before-retrieval/variant-scaling";
const captured = await Bun.file(`${root}/split-verified/report.json`).json();
const rows = [];
for (const corpus of captured.corpora) {
  const client = await reader(`${corpus.directory}/index.sqlite`);
  try {
    for (const workload of ["broad", "rare-tag", "beta-owner", "whole-document-exclusion", "empty-scope"]) {
      for (const limit of [1, 10]) {
        const options = {limit, lang: "en", noExpand: true, noRerank: true, noGraph: true, ...(workload === "rare-tag" ? {tagsAll: ["rare"]} : {}), ...(workload === "beta-owner" ? {tagsAll: ["beta"]} : {}), ...(workload === "whole-document-exclusion" ? {exclude: ["noise"]} : {}), ...(workload === "empty-scope" ? {retrievalScope: {allowedMirrorHashes: []}} : {})};
        const deps = {store: client.store, vectorIndex: client.vector, embedPort, config: {} as Config};
        const vector = must(await searchVectorWithEmbedding(deps, "needle", new Float32Array([1, 0]), options));
        const hybrid = must(await searchHybrid({...deps, expandPort: null, rerankPort: null}, "needle", options));
        if (!vector.meta.vectorsUsed || !hybrid.meta.vectorsUsed) throw new Error("Hidden semantic fallback");
        rows.push({size: corpus.size, workload, limit, vector, hybrid});
      }
    }
  } finally {client.db.close(); await client.store.close();}
}
await Bun.write(`${root}/semantic-state-verification.json`, JSON.stringify({scope: "60 sequential calls on retained activated snapshots after the documented stale-title mutation; no timing interpretation; both vector/hybrid meta.vectorsUsed asserted for all calls", rows}, null, 2));
