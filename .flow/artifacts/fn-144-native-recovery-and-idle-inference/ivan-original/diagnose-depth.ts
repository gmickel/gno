/** Exact CLI depth resolution and read-only lexical strength, no native inference. */
const root=process.argv[2];
Bun.spawn=(()=>{throw Error('READONLY_DIAGNOSTIC_NO_SUBPROCESS');}) as typeof Bun.spawn;
const config=await Bun.file(`${root}/config/index.yml`).json();
const {resolveDepthPolicy}=await import(`${root}/source/src/core/depth-policy.ts`);
const {SqliteAdapter}=await import(`${root}/source/src/store/sqlite/adapter.ts`);
const presetId=config.models.activePreset;
const exactCliInput={presetId,fast:false,thorough:false,expand:undefined,rerank:undefined,candidateLimit:undefined};
const actualDepthPolicy=resolveDepthPolicy(exactCliInput);
const store=new SqliteAdapter();const opened=store.openReadOnly(`${root}/data/index-default.sqlite`);if(!opened.ok)throw Error(JSON.stringify(opened.error));
try {
 const fts=await store.searchFts('what retry budget did we decide and why',{limit:5,excludeMetadata:true,semanticMetadata:true});
 const scores=fts.ok?fts.value.map((x:{score:number})=>1/(1+Math.exp(-(Math.abs(x.score)-4.5)/2.8))).sort((a:number,b:number)=>b-a):[];
 const strength={scores,top:scores[0]??0,gap:(scores[0]??0)-(scores[1]??0),strong:(scores[0]??0)>=.84&&(scores[0]??0)-(scores[1]??0)>=.14};
 const receipt={nativeInference:false,childSpawnForbidden:true,exactCliInput,actualDepthPolicy,expansionBranchEntered:!actualDepthPolicy.noExpand,readOnlyDerivedFts:fts,strength,clarification:'Lexical strength derived separately; original CLI did not enter expansion branch because resolved noExpand=true.',proposedSeparatePresetPolicy:resolveDepthPolicy({...exactCliInput,presetId:'slim-tuned'})};
 await Bun.write(`${root}/evidence/depth-parent-diagnostic.json`,JSON.stringify(receipt,null,2));console.log(JSON.stringify({actualDepthPolicy,strength,proposed:receipt.proposedSeparatePresetPolicy}));
}finally{await store.close();}
