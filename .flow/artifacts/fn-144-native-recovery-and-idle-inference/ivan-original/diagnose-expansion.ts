/** Parent-only resolution/approval diagnostic. Native child spawning forbidden. */
const root=process.argv[2];
const originalSpawn=Bun.spawn;
Bun.spawn=(()=>{throw Error('READONLY_DIAGNOSTIC_NO_SUBPROCESS');}) as typeof Bun.spawn;
const {LlmAdapter}=await import(`${root}/source/src/llm/nodeLlamaCpp/adapter.ts`);
const {resolveModelUri}=await import(`${root}/source/src/llm/registry.ts`);
const config=JSON.parse(await Bun.file(`${root}/config/index.yml`).text());
const uri=resolveModelUri(config,'expand',undefined,undefined);
const adapter=new LlmAdapter(config,`${root}/cache`);
try {
 const result=await adapter.createExpansionPort(uri,{egressCollections:'all',policy:{offline:true,allowDownload:false}});
 const output={nativeInference:false,childSpawnForbidden:true,selectedExpandUri:uri,fileExists:await Bun.file(uri.slice(5)).exists(),result:result.ok?{ok:true,portClass:result.value.constructor.name}:result,lifecycle:adapter.getLifecycleStats()};
 await Bun.write(`${root}/evidence/expansion-parent-diagnostic.json`,JSON.stringify(output,null,2));console.log(JSON.stringify(output));
} finally {await adapter.dispose();Bun.spawn=originalSpawn;}
