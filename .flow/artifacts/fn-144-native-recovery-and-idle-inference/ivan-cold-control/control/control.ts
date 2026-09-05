import {join} from 'node:path';
const root=process.argv[2];
if(!root)throw Error('Owned root required');
const setup=await Bun.file(join(root,'setup.json')).json();
const {ModelCache}=await import(join(setup.sourceRoot,'src/llm/cache.ts'));
const {createGnoClient}=await import(join(setup.sourceRoot,'src/sdk/client.ts'));
const started=performance.now();
const cache=new ModelCache(join(root,'cache'));
for(const model of setup.manifest.models){
 const resolved=await cache.ensureModel(model.id,model.role==='embedding'?'embed':model.role==='reranking'?'rerank':'gen',{offline:true,allowDownload:false});
 if(!resolved.ok)throw Error(resolved.error.message);
 const hash=new Bun.CryptoHasher('sha256');
 for await(const bytes of Bun.file(resolved.value).stream())hash.update(bytes);
 if(hash.digest('hex')!==model.sha256)throw Error('Model hash mismatch');
}
const preflightMs=performance.now()-started;
const client=await createGnoClient({config:setup.config,dbPath:join(root,'data/index-default.sqlite'),cacheDir:join(root,'cache'),downloadPolicy:{offline:true,allowDownload:false}});
try {
 const at=performance.now();
 const result=await client.query(setup.request.query,{...setup.request.options,explain:true});
 await Bun.write(join(root,'evidence/plain-result.json'),JSON.stringify({result,queryDurationMs:performance.now()-at,preflightMs,wholeDurationMs:performance.now()-started,control:'public SDK, no capture preload or native hooks; backend not independently observed'},null,2));
 console.log(JSON.stringify(result.meta));
}finally{await client.close();}
