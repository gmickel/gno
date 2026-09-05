/** Response-only fn143 comparator projection; explicitly not native capture. */
const root=import.meta.dir;
const harness=new URL("../../../../evals", import.meta.url).pathname;
const {compareAcceptance}=await import(`${harness}/acceptance/compare.ts`);
const {freezeAcceptanceManifest,acceptanceManifestFingerprint}=await import(`${harness}/acceptance/manifest.ts`);
const {canonicalFingerprint,canonicalJson}=await import(`${harness}/agentic/canonical.ts`);
const payload=JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await Bun.file(`${root}/full-results.json.gz`).arrayBuffer()))));
const rows=payload.normal;
const pins=await Bun.file(`${root}/model-pins.json`).json();
const index=await Bun.file(`${root}/index-pins.json`).json();
const receipt=await Bun.file(`${root}/receipt.json`).json();

const cases=rows.map((row:any)=>({caseId:row.stage,fixtureSha256:canonicalFingerprint(receipt.corpus),surface:'api',preset:'audit-default-equivalent',configuration:{request:row.request,comparisonScope:'posthoc full REST result array equality; native evidence unavailable'}}));
const common={schemaVersion:'gno-acceptance-v1',identity:{commit:receipt.sourceCommit,indexId:'default',indexSha256:index.snapshotSha256,bunVersion:'1.3.14',nativeDependencies:{'node-llama-cpp':'3.19.1'},platform:'linux',architecture:'x64'},fixtureVersion:'original-orchid-30-documents',fixtures:[{path:'receipt.corpus',sha256:canonicalFingerprint(receipt.corpus)}],models:Object.entries(pins).map(([name,m]:any)=>({role:name.includes('Embedding')?'embedding':name.includes('reranker')?'reranking':'generation',id:`file:/home/gordon/.cache/gno/models/${name}`,sha256:m.sha256,tokenizerSha256:m.sha256})),cases,intendedDeltas:[]};
const a=freezeAcceptanceManifest({...common,role:'baseline'}),b=freezeAcceptanceManifest({...common,role:'candidate'});
function record(manifest:any,row:any,results:any[]) {
 return {schemaVersion:'gno-acceptance-v1',manifestSha256:acceptanceManifestFingerprint(manifest),caseId:row.stage,deterministic:{scope:{request:row.request,comparisonScope:'response-only'},results:results.map(x=>({uri:x.uri,score:x.score,scores:{},passage:null,provenance:{fullUnmodifiedResult:x}})),citations:[],modelInputs:[],semanticState:{status:'incomplete',vectorsUsed:false,vectorStatus:'unavailable',error:'Actual child-native capture not collected in task144.4; this record proves only public result equality.',fallbacks:[],verification:null}},generatedAnswer:null,transport:{}};
}
const before=rows.map((r:any)=>record(a,r,rows[0].body.results));
const after=rows.map((r:any)=>record(b,r,r.body.results));
const comparison=compareAcceptance(a,b,before,after);
const negative=structuredClone(after);negative[0].deterministic.results[0].score+=0.125;
const evidence={scope:'Posthoc response-only exact comparison, not native acceptance or preregistered performance',nativeCoverage:'incomplete',comparison,negative:compareAcceptance(a,b,before,negative),normalizations:[],manifests:[a,b],records:{baseline:before,candidate:after}};
await Bun.write(`${root}/fn143-response-comparison.json.gz`,Bun.gzipSync(JSON.stringify(evidence)));
await Bun.write(`${root}/fn143-response-comparison.json`,JSON.stringify({...evidence,manifests:undefined,records:undefined,fullRecords:"fn143-response-comparison.json.gz"},null,2));
console.log(JSON.stringify({comparison,normalizations:[]}));
