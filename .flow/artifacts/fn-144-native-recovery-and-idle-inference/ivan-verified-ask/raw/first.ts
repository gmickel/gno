import {join} from 'node:path';
const [flag,root]=process.argv.slice(2);
if(flag!=='--native'||!root)throw Error('Explicit native run required');
const setup=await Bun.file(join(root,'setup.json')).json();
const {createSessionDriverFactory}=await import(join(setup.sourceRoot,'evals/acceptance/session-driver.ts'));
const {OwnedResources}=await import(join(setup.sourceRoot,'evals/acceptance/resources.ts'));
const scope=new OwnedResources(false);
let session:any;
const started=performance.now();
try{
 session=await createSessionDriverFactory({sourceRoot:setup.sourceRoot,isolatedRoot:root,protocolRoot:join(root,'protocol'),manifest:setup.manifest,init:{config:setup.config,dbPath:join(root,'data/index-default.sqlite'),cacheDir:join(root,'cache')},requests:[setup.request],timeoutMs:110000}).open(scope);
 scope.start(100);
 const before=await session.modelState();
 const at=performance.now();
 const result=await session.run(setup.request.caseId);
 const after=await session.modelState();
 await Bun.write(join(root,'evidence/result.json'),JSON.stringify({before,after,result,queryDurationMs:performance.now()-at,wholeDurationMs:performance.now()-started,processIdentity:session.processIdentity},null,2));
 console.log(JSON.stringify({coverage:result.coverage,reasons:result.reasons,results:result.record.deterministic.results.length,before,after}));
 if(result.coverage!=='complete')process.exitCode=2;
}finally{
 await scope.stopSampling();
 try{await session?.close();}finally{await scope.close();}
 await Bun.write(join(root,'evidence/resources.json'),JSON.stringify({samples:scope.samples,errors:scope.errors,nativeChildren:scope.descendantEvents},null,2));
 if(scope.errors.length)process.exitCode=2;
}
