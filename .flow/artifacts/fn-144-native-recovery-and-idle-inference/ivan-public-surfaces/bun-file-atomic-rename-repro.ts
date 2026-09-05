import { mkdtemp, rename } from "node:fs/promises";
const root = await mkdtemp("/home/gordon/.cache/agent-tmp/gno-fn144-childcapture/bun-file-repro-");
const path = `${root}/children.json`;
const first = JSON.stringify([{event:"birth"}]);
const second = JSON.stringify([{event:"birth"},{event:"exit",exitCode:0}]);
await Bun.write(path, first);
const stale = Bun.file(path);
await stale.exists();
await Bun.write(`${path}.next`, second);
await rename(`${path}.next`, path);
let staleError: string | null = null;
try { await stale.json(); } catch (error) { staleError = String(error); }
console.log(JSON.stringify({bun:Bun.version,root,firstBytes:first.length,secondBytes:second.length,cachedSize:stale.size,staleText:await stale.text(),staleError,fresh:await Bun.file(path).json()},null,2));
if (!staleError) throw new Error("Expected original cached-length failure on pinned Bun");
