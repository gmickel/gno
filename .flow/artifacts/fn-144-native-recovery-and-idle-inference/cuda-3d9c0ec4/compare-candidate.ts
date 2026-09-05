const root=import.meta.dir;
const source=`${root}/source`;
const {compareAcceptance}=await import(`${source}/evals/acceptance/compare.ts`);
const {ACCEPTANCE_SCHEMA_VERSION,acceptanceManifestFingerprint}=await import(`${source}/evals/acceptance/manifest.ts`);
const hash=(s:string)=>new Bun.CryptoHasher('sha256').update(s).digest('hex');
const cases=await Bun.file(`${root}/evidence/matrix-summary.json`).json();
const scriptHash=hash(await Bun.file(`${root}/matrix.ts`).text());
const model='file:/home/gordon/.cache/gno/models/hf_Qwen_Qwen3-Embedding-0.6B-Q8_0.gguf';
const comparisons=[];
for(const {name} of cases){
 const d=await Bun.file(`${root}/evidence/matrix-${name}.json`).json();
 const baseline:any={schemaVersion:ACCEPTANCE_SCHEMA_VERSION,role:'baseline',identity:{commit:'3d9c0ec49c502ab0c3470c7df14ddac8123ad8d9',indexId:`clean-${name}-logical-snapshot`,indexSha256:hash(JSON.stringify(d.rebuilt)),bunVersion:Bun.version,nativeDependencies:{'node-llama-cpp':'3.19.1'},platform:process.platform,architecture:process.arch},fixtureVersion:'fn147-native-mutation-matrix-v1',fixtures:[{path:'matrix.ts',sha256:scriptHash}],models:[{role:'embedding',id:model,sha256:'06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439',tokenizerSha256:'06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439'}],cases:[{caseId:name,fixtureSha256:scriptHash,surface:'sdk',preset:'synthetic',configuration:{query:'cobalt observatory dawn',comparison:'full public result objects and exact active owner/input/vector hashes; native transcript retained separately in sdk-matrix.capture.json; this comparison projects observable state only'}}],intendedDeltas:[]};
 const candidate=structuredClone(baseline);candidate.role='candidate';candidate.identity.indexId=`incremental-${name}-logical-snapshot`;candidate.identity.indexSha256=hash(JSON.stringify(d.current));
 const record=(manifest:any,owners:any,keyword:any,semantic:any)=>({schemaVersion:ACCEPTANCE_SCHEMA_VERSION,manifestSha256:acceptanceManifestFingerprint(manifest),caseId:name,deterministic:{scope:{owners,keyword,semantic},results:[],citations:[],modelInputs:[],semanticState:{status:'incomplete',vectorsUsed:false,vectorStatus:'unavailable',error:null,fallbacks:[],verification:{scope:'mechanical observable-state projection only',nativeTranscript:'retained separately; not consumed by this observable-state comparator'}}},generatedAnswer:null,transport:{}});
 const records=[record(baseline,d.rebuilt.owners,d.cleanKeyword,d.cleanSemantic),record(candidate,d.current.owners,d.keyword,d.semantic)];
 const comparison=compareAcceptance(baseline,candidate,[records[0]],[records[1]]);
 const complete=d.embed.ok&&d.cleanEmbed.ok&&d.semantic.ok&&d.cleanSemantic.ok;
 comparisons.push({name,completeEmbeddingPair:complete,comparison,acceptance:complete&&comparison.passed?'observable-state parity':'incomplete'});
 await Bun.write(`${root}/evidence/comparator-${name}.json`,JSON.stringify({baseline,candidate,records,comparison,completeEmbeddingPair:complete},null,2));
}
await Bun.write(`${root}/evidence/comparator-summary.json`,JSON.stringify(comparisons,null,2));
console.log(JSON.stringify(comparisons.map(x=>({name:x.name,complete:x.completeEmbeddingPair,passed:x.comparison.passed}))));
