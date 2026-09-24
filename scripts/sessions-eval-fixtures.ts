/**
 * Refresh the sessions eval fixture pins.
 *
 *   bun scripts/sessions-eval-fixtures.ts
 *
 * Formats the JSON fixtures with the repo formatter, then rehashes every file
 * under evals/fixtures/sessions/ (except manifest.json) into manifest.json
 * through the eval's single fixture walk (`buildSessionsManifest`). Review the
 * fixture diff before committing: the pins freeze what
 * `bun run eval:sessions` measures, and a fixture is never edited to make the
 * pipeline arm pass.
 *
 * @module scripts/sessions-eval-fixtures
 */

import {
  listSessionsFixtureFiles,
  SESSIONS_FIXTURE_MANIFEST,
  writeSessionsManifest,
} from "../evals/helpers/sessions-fixtures";

const json = (await listSessionsFixtureFiles()).filter(
  (path) =>
    path.endsWith(".json") && !path.endsWith(`/${SESSIONS_FIXTURE_MANIFEST}`)
);
if (json.length > 0) await Bun.$`bun x oxfmt ${json}`.quiet();

const { path, manifest } = await writeSessionsManifest();
// Match the repo formatter so the committed manifest is lint-clean.
await Bun.$`bun x oxfmt ${path}`.quiet();
console.log(
  `wrote ${SESSIONS_FIXTURE_MANIFEST} (${Object.keys(manifest.files).length} fixtures)`
);
