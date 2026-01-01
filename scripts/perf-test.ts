/**
 * Performance and accuracy testing for search pipeline.
 * Tests different configurations to find optimal defaults.
 */

import { performance } from 'node:perf_hooks';

const times: Record<string, number> = {};
const mark = (label: string) => {
  times[label] = performance.now();
};
const since = (label: string) =>
  ((performance.now() - (times[label] ?? 0)) / 1000).toFixed(2);

// Test query that requires good retrieval
const TEST_QUERY = 'which model scores best on gmickel-bench?';
const EXPECTED_ANSWER = 'GPT-5.2-xhigh';

console.log('=== GNO Performance & Accuracy Test ===\n');

mark('start');

// Imports
const { searchHybrid } = await import('../src/pipeline/hybrid');
const { initStore } = await import('../src/cli/commands/shared');
const { LlmAdapter } = await import('../src/llm/nodeLlamaCpp/adapter');
const { getActivePreset } = await import('../src/llm/registry');
mark('import');
console.log(`Import: ${since('start')}s`);

// Store + Config
const initResult = await initStore();
if (!initResult.ok) {
  console.error('Failed to init store:', initResult.error);
  process.exit(1);
}
const { store, config } = initResult;
mark('store');
console.log(`Store: ${since('import')}s\n`);

// Config + Adapter
const preset = getActivePreset(config);
const llm = new LlmAdapter(config);

// Create ports
console.log(
  `Preset: embed=${preset.embed}, gen=${preset.gen}, rerank=${preset.rerank}`
);
mark('ports_start');

mark('embed_load');
const embedResult = await llm.createEmbeddingPort(preset.embed);
if (!embedResult.ok) {
  console.error('Failed to create embed port');
  process.exit(1);
}
const embedPort = embedResult.value;
console.log(`  Embed port: ${since('embed_load')}s`);

mark('rerank_load');
const rerankResult = preset.rerank
  ? await llm.createRerankPort(preset.rerank)
  : {
      ok: false as const,
      error: { code: 'NO_MODEL' as const, message: 'no rerank model' },
    };
const rerankPort = rerankResult.ok ? rerankResult.value : null;
console.log(
  `  Rerank port: ${since('rerank_load')}s (${rerankPort ? 'loaded' : 'skipped'})`
);

mark('gen_load');
const genResult = preset.gen
  ? await llm.createGenerationPort(preset.gen)
  : {
      ok: false as const,
      error: { code: 'NO_MODEL' as const, message: 'no gen model' },
    };
const genPort = genResult.ok ? genResult.value : null;
console.log(
  `  Gen port: ${since('gen_load')}s (${genPort ? 'loaded' : 'skipped'})`
);

console.log(`Total ports: ${since('ports_start')}s\n`);

// Helper to check if result contains expected answer
function checkAccuracy(
  results: Array<{ snippet?: string; source?: { relPath?: string } }>
): boolean {
  for (const r of results) {
    if (
      r.snippet?.includes(EXPECTED_ANSWER) ||
      r.source?.relPath?.includes('gmickel-bench')
    ) {
      return true;
    }
  }
  return false;
}

console.log('--- Test Configurations ---\n');

// Test 1: Thorough mode (full pipeline)
mark('t1');
const r1 = await searchHybrid(
  { store, config, vectorIndex: null, embedPort, genPort, rerankPort },
  TEST_QUERY,
  { limit: 5 }
);
const t1Results = r1.ok ? r1.value.results : [];
console.log(`1. Thorough mode (expand + rerank): ${since('t1')}s`);
console.log(
  `   Results: ${t1Results.length}, Accurate: ${checkAccuracy(t1Results)}`
);
if (t1Results.length > 0) {
  console.log(`   Top result: ${t1Results[0]?.source?.relPath ?? 'unknown'}`);
  console.log(
    `   Snippet: ${t1Results[0]?.snippet?.slice(0, 100) ?? 'none'}...`
  );
}

// Test 2: Default mode (no expansion, with rerank)
mark('t2');
const r2 = await searchHybrid(
  {
    store,
    config,
    vectorIndex: null,
    embedPort,
    genPort: null, // No expansion
    rerankPort,
  },
  TEST_QUERY,
  { limit: 5, noExpand: true }
);
const t2Results = r2.ok ? r2.value.results : [];
console.log(`2. Default mode (no expand, with rerank): ${since('t2')}s`);
console.log(
  `   Results: ${t2Results.length}, Accurate: ${checkAccuracy(t2Results)}`
);

// Test 3: Fast mode (no expansion, no rerank)
mark('t3');
const r3 = await searchHybrid(
  {
    store,
    config,
    vectorIndex: null,
    embedPort,
    genPort: null,
    rerankPort: null,
  },
  TEST_QUERY,
  { limit: 5, noExpand: true, noRerank: true }
);
const t3Results = r3.ok ? r3.value.results : [];
console.log(`3. Fast mode (no expand, no rerank): ${since('t3')}s`);
console.log(
  `   Results: ${t3Results.length}, Accurate: ${checkAccuracy(t3Results)}`
);

// Test 4: With expansion, no rerank
mark('t4');
const r4 = await searchHybrid(
  {
    store,
    config,
    vectorIndex: null,
    embedPort,
    genPort,
    rerankPort: null,
  },
  TEST_QUERY,
  { limit: 5, noRerank: true }
);
const t4Results = r4.ok ? r4.value.results : [];
console.log(`4. With expansion, no rerank: ${since('t4')}s`);
console.log(
  `   Results: ${t4Results.length}, Accurate: ${checkAccuracy(t4Results)}`
);

console.log('\n--- Summary ---');
console.log(`Total test time: ${since('start')}s`);
console.log('\nSearch modes:');
console.log('  --fast     ~0.7s  (no expand, no rerank)');
console.log('  (default)  ~2-3s  (no expand, with rerank)');
console.log('  --thorough ~5-8s  (full pipeline)');

// Cleanup
await embedPort.dispose();
if (rerankPort) {
  await rerankPort.dispose();
}
if (genPort) {
  await genPort.dispose();
}
await store.close();
