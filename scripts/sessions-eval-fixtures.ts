/**
 * Refresh the sessions eval fixture pins.
 *
 *   bun scripts/sessions-eval-fixtures.ts
 *
 * Formats the JSON fixtures with the repo formatter, then rehashes every file
 * under evals/fixtures/sessions/ (except manifest.json) into manifest.json.
 * Review the fixture diff before committing: the pins freeze what
 * `bun run eval:sessions` measures, and a fixture is never edited to make the
 * pipeline arm pass.
 *
 * @module scripts/sessions-eval-fixtures
 */

// node:fs/promises readdir enumerates the fixture tree (structure op)
import { readdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../evals/fixtures/sessions");
const MANIFEST = "manifest.json";

const entries = await readdir(ROOT, { recursive: true, withFileTypes: true });
const paths = entries
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name))
  .sort();

const json = paths.filter((path) => path.endsWith(".json"));
if (json.length > 0) await Bun.$`bun x oxfmt ${json}`.quiet();

const files: Record<string, string> = {};
for (const path of paths) {
  const rel = relative(ROOT, path).split("\\").join("/");
  if (rel === MANIFEST) continue;
  files[rel] = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");
}

const manifestPath = join(ROOT, MANIFEST);
await Bun.write(
  manifestPath,
  `${JSON.stringify({ algorithm: "sha256", files }, null, 2)}\n`
);
// Match the repo formatter so the committed manifest is lint-clean.
await Bun.$`bun x oxfmt ${manifestPath}`.quiet();
console.log(`wrote ${MANIFEST} (${Object.keys(files).length} fixtures)`);
