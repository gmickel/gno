// Synthetic setup only. Public retrieval is exercised by drive.ts and browser.
import { mkdir } from "node:fs/promises";
const source = "/home/gordon/.cache/agent-tmp/gno-fn148-public/source";
const root = "/home/gordon/.cache/agent-tmp/gno-fn148-public/runtime";
const { SqliteAdapter } = await import(`${source}/src/store/sqlite/adapter.ts`);
const { eligibleTopKFixture } = await import(`${source}/evals/fixtures/acceptance/eligible-top-k/fixture.ts`);
for (const dir of ["config", "data", "cache", "tmp", "corpus/scope"]) await mkdir(`${root}/${dir}`, {recursive:true});
const fixture = eligibleTopKFixture();
const manifest = await Bun.file(`${source}/evals/fixtures/acceptance/eligible-top-k/manifest.json`).json();
const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify(fixture)).digest("hex");
if (hash !== manifest.corpusSha256) throw new Error("Fixture hash mismatch");
const collections = [{name:"notes",path:`${root}/corpus`,pattern:"**/*",include:[],exclude:[],watch:false}];
await Bun.write(`${root}/config/index.yml`, Bun.YAML.stringify({version:"1.0",ftsTokenizer:"unicode61",collections,contexts:[]}));
const store = new SqliteAdapter();
function check(result:any) {if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value;}
check(await store.open(`${root}/data/index-default.sqlite`, "unicode61"));
check(await store.syncCollections(collections));
for (const {doc,chunks,tags} of fixture) {
  const inserted = check(await store.upsertDocument({...doc, title:doc.title??undefined, categories:doc.categories??undefined,author:doc.author??undefined}));
  const body = chunks.map((c:any)=>c.text).join("\n");
  await Bun.write(`${root}/corpus/${doc.relPath}`,body);
  check(await store.upsertContent(doc.mirrorHash,body));
  check(await store.upsertChunks(doc.mirrorHash,chunks.map((c:any)=>({...c,language:c.language??undefined,tokenCount:c.tokenCount??undefined}))));
  check(await store.setDocTags(inserted.id,tags,"frontmatter"));
  check(await store.rebuildFtsForHash(doc.mirrorHash));
  if (!doc.active) check(await store.markInactive(doc.collection,[doc.relPath]));
}
await store.close();
await Bun.write(new URL("fixture-receipt.json",import.meta.url),JSON.stringify({candidate:"23ba2c25",corpusSha256:hash,documents:fixture.length,target:"gno://notes/scope/target.md",root,manifest},null,2));
