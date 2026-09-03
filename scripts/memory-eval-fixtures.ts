/**
 * Refresh the memory eval fixture pins.
 *
 *   bun run eval:memory:fixtures            # rehash evals/fixtures/memory/manifest.json
 *   bun run eval:memory:fixtures --golden   # also regenerate agent-day.golden.json
 *                                           # from a fresh run, then rehash
 *
 * `--golden` replays the scripted agent day through the SDK against a temp
 * index and writes the resulting end state as the new golden. Review the diff
 * before committing: the golden is the expectation, not an observation.
 *
 * @module scripts/memory-eval-fixtures
 */

import type {
  AgentDayFixture,
  AgentDayGolden,
} from "../evals/helpers/memory-fixtures";

import {
  fixturePath,
  manifestDigest,
  writeFixtureManifest,
} from "../evals/helpers/memory-fixtures";
import { cleanupMemoryEvalClient } from "../evals/helpers/memory-harness";
import { runAgentDay } from "../evals/helpers/memory-suite-agent-day";

const writeGolden = process.argv.includes("--golden");

if (writeGolden) {
  const fixture = (await Bun.file(
    fixturePath("agent-day.json")
  ).json()) as AgentDayFixture;
  // The temp eval client must be closed and removed even when the day throws.
  let offScript = 0;
  try {
    const day = await runAgentDay(fixture, null);
    const failed = day.turns.filter((turn) => !turn.ok);
    offScript = failed.length;
    if (failed.length > 0) {
      console.error(
        `agent day has ${failed.length} turn(s) off script; fix the fixture before writing a golden:`
      );
      for (const turn of failed) {
        console.error(
          `  ${turn.id} ${turn.op}: expected ${turn.expected}, got ${turn.outcome}`
        );
      }
    } else {
      const golden: AgentDayGolden = day.actual;
      const goldenPath = fixturePath("agent-day.golden.json");
      await Bun.write(goldenPath, `${JSON.stringify(golden, null, 2)}\n`);
      // Match the repo formatter so the pinned hash equals the committed bytes.
      await Bun.$`bun x oxfmt ${goldenPath}`.quiet();
      console.log(
        `wrote agent-day.golden.json (${golden.records.length} records, ${Object.keys(golden.recalls).length} recalls)`
      );
    }
  } finally {
    await cleanupMemoryEvalClient();
  }
  if (offScript > 0) process.exit(1);
}

const manifest = await writeFixtureManifest();
console.log(`wrote manifest.json (fixture set ${manifestDigest(manifest)})`);
