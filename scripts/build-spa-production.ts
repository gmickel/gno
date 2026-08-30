/**
 * Prebuild the production WebUI SPA into assets/spa-production.json.gz.
 *
 * Production `gno serve` (source and `bun build --compile`) loads this
 * snapshot instead of calling Bun.build at listen time. Compiled binaries
 * also cannot call Bun.build on /$bunfs. Use `--dev` for a live HTMLBundle.
 */

import { join } from "node:path";

import { buildProductionSpaAssets } from "../src/serve/spa-production-build";

const repoRoot = join(import.meta.dir, "..");
const outPath = join(repoRoot, "assets", "spa-production.json.gz");

const assets = await buildProductionSpaAssets();
const json = JSON.stringify(assets);
const gzip = Bun.gzipSync(json);
await Bun.write(outPath, gzip);
console.log(
  `Wrote ${outPath} (${gzip.byteLength} bytes gzip, ${json.length} bytes json, ${Object.keys(assets.files).length} files, sourceHash ${assets.sourceHash})`
);
