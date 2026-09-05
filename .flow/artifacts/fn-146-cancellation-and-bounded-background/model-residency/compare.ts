const root=import.meta.dir;
const {compareAcceptance}=await import(`${root}/comparator/acceptance/compare.ts`);
const {canonicalJson}=await import(`${root}/comparator/agentic/canonical.ts`);
const same=(a:any,b:any)=>a===undefined||b===undefined?a===b:canonicalJson(a)===canonicalJson(b);
const a=JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await Bun.file(`${root}/baseline/result.json.gz`).bytes()))),b=JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await Bun.file(`${root}/candidate/result.json.gz`).bytes())));
const ap=await Bun.file(`${root}/baseline/plan.json`).json(),bp=await Bun.file(`${root}/candidate/plan.json`).json();
const ar=a.results.filter((r:any)=>r.projected),br=b.results.filter((r:any)=>r.projected);
const pairs=ar.map((x:any,i:number)=>{const y=br[i];return {caseId:x.label,coverage:[x.projected.coverage,y.projected.coverage],reasons:[x.projected.reasons,y.projected.reasons],fullResultsEqual:same(x.raw?.results,y.raw?.results),deterministicRecordEqual:same(x.projected.record.deterministic,y.projected.record.deterministic),generatedAnswerEqual:same(x.projected.record.generatedAnswer,y.projected.record.generatedAnswer),modelInputsEqual:same(x.receipt.modelInputs,y.receipt.modelInputs),modelOutputsEqual:same(x.receipt.modelOutputs,y.receipt.modelOutputs)};});
const embeddings=a.results.filter((r:any)=>r.label.startsWith('paced-')||r.label==='retained-final').map((x:any)=>{const y=b.results.find((r:any)=>r.label===x.label);return {label:x.label,baselineOk:x.output?.ok,candidateOk:y.output?.ok,pairedEqual:same(x.output,y.output),baselineInitialEqual:same(x.output,a.results.find((r:any)=>r.label==='paced-0').output),candidateInitialEqual:same(y.output,b.results.find((r:any)=>r.label==='paced-0').output)};});
const output={strict:compareAcceptance(ap.manifest,bp.manifest,ar.map((r:any)=>r.projected.record),br.map((r:any)=>r.projected.record)),pairs,embeddings};
await Bun.write(`${root}/comparison.json`,JSON.stringify(output,null,2));console.log(JSON.stringify(output));

