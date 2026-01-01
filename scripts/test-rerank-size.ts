// Test what happens with large documents in reranker
import { initStore } from '../src/cli/commands/shared';
import { LlmAdapter } from '../src/llm/nodeLlamaCpp/adapter';
import { getActivePreset } from '../src/llm/registry';

const init = await initStore();
if (!init.ok) {
  console.error(init.error);
  process.exit(1);
}

const preset = getActivePreset(init.config);
const llm = new LlmAdapter(init.config);

const rerankResult = await llm.createRerankPort(preset.rerank);
if (!rerankResult.ok) {
  console.error('No rerank port');
  process.exit(1);
}
const rerankPort = rerankResult.value;

// Test with different doc sizes
const sizes = [1000, 4000, 16_000, 32_000, 64_000, 128_000];
const query = 'test query';

for (const size of sizes) {
  const doc = 'x'.repeat(size);
  const start = performance.now();
  try {
    const result = await rerankPort.rerank(query, [doc]);
    const elapsed = ((performance.now() - start) / 1000).toFixed(2);
    const score = result.ok ? result.value[0]?.score.toFixed(3) : 'error';
    console.log(`${size} chars: ${elapsed}s, score=${score}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${size} chars: ERROR - ${msg}`);
  }
}

await rerankPort.dispose();
await init.store.close();
