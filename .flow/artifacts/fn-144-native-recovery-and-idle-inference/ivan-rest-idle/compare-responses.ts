/** Response-only fn143 comparator projection; explicitly not native capture. */
const root=import.meta.dir;
const harness=`${root}/../fn145-qa/surfaces/candidate/evals`;
const {compareAcceptance}=await import(`${harness}/acceptance/compare.ts`);
const {freezeAcceptanceManifest,acceptanceManifestFingerprint}=await import(`${harness}/acceptance/manifest.ts`);
const {canonicalFingerprint,canonicalJson}=await import(`${harness}/agentic/canonical.ts`);
const rows=await Bun.file(`${root}/raw/results.json`).json();
const pins=await Bun.file(`${root}/raw/pins.json`).json();
const receipt=await Bun.file(`${root}/raw/receipt.json`).json();
const historical=await Bun.file('/tmp/paired-baseline-ivan-evidence-9cgs4qx6/evidence/ttl-api/first.response.json').json();
const cases=rows.map((row:any)=>({caseId:row.stage,fixtureSha256:canonicalFingerprint(receipt.corpus),surface:'api',preset:'audit-default-equivalent',configuration:{request:row.request,comparisonScope:'posthoc full REST result array equality; native evidence unavailable'}}));
const common={schemaVersion:'gno-acceptance-v1',identity:{commit:receipt.sourceCommit,indexId:'default',indexSha256:pins.dbSha256AfterRun,bunVersion:'1.3.14',nativeDependencies:{'node-llama-cpp':'3.19.1'},platform:'darwin',architecture:'arm64'},fixtureVersion:'original-orchid-30-documents',fixtures:[{path:'receipt.corpus',sha256:canonicalFingerprint(receipt.corpus)}],models:pins.models.map((m:any)=>({role:m.role==='embed'?'embedding':m.role==='rerank'?'reranking':'generation',id:m.uri,sha256:m.sha256,tokenizerSha256:m.sha256})),cases,intendedDeltas:[]};
const a=freezeAcceptanceManifest({...common,role:'baseline'}),b=freezeAcceptanceManifest({...common,role:'candidate'});
function record(manifest:any,row:any,results:any[]) {
 return {schemaVersion:'gno-acceptance-v1',manifestSha256:acceptanceManifestFingerprint(manifest),caseId:row.stage,deterministic:{scope:{request:row.request,comparisonScope:'response-only'},results:results.map(x=>({uri:x.uri,score:x.score,scores:{},passage:null,provenance:{fullUnmodifiedResult:x}})),citations:[],modelInputs:[],semanticState:{status:'incomplete',vectorsUsed:false,vectorStatus:'unavailable',error:'Actual child-native capture not collected in task144.4; this record proves only public result equality.',fallbacks:[],verification:null}},generatedAnswer:null,transport:{}};
}
const before=rows.map((r:any)=>record(a,r,rows[0].body.results));
const after=rows.map((r:any)=>record(b,r,r.body.results));
const comparison=compareAcceptance(a,b,before,after);
const negative=structuredClone(after);negative[0].deterministic.results[0].score+=0.125;
await Bun.write(`${root}/fn143-response-comparison.json`,JSON.stringify({scope:'Posthoc response-only exact comparison, not native acceptance or preregistered performance',nativeCoverage:'incomplete',comparison,negative:compareAcceptance(a,b,before,negative),historicalBaselineFullResultsExact:rows.map((r:any)=>({stage:r.stage,equal:canonicalJson(historical.results)===canonicalJson(r.body.results)})),normalizations:[],manifests:[a,b],records:{baseline:before,candidate:after}},null,2));
console.log(JSON.stringify({comparison,historicalAllEqual:rows.every((r:any)=>canonicalJson(historical.results)===canonicalJson(r.body.results))}));
