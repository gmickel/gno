// Scratch-only public SDK sequence; native inference arguments remain unchanged.
import {join} from 'node:path'; // Bun has no path-join API.
const root=import.meta.dir;
const plan=await Bun.file(process.argv[2]!).json();
const role=plan.manifest.role;
const harness='/home/gordon/.cache/agent-tmp/gno-fn144-packed-surfaces-98252a9c/package/evals/acceptance';
const {createSessionDriverFactory}=await import(join(harness,'session-driver.ts'));
const {OwnedResources}=await import(join(harness,'resources.ts'));
const scope=new OwnedResources(true);
const output:any={role,plan,results:[],transitions:[]};
let session:any;
const save=()=>Bun.write(plan.outputPath,JSON.stringify(output,null,2));
try{
 session=await createSessionDriverFactory(plan).open(scope);scope.start(100);
 output.processIdentity=session.processIdentity;
 const check=Bun.spawn([process.execPath,'--no-env-file',join(root,'snapshot.ts'),plan.sourceRoot,plan.init.dbPath],{stdout:'pipe',stderr:'pipe'});
 const snapshot=await new Response(check.stdout).text();const stderr=await new Response(check.stderr).text();
 if(await check.exited!==0)throw Error(stderr);
 const expected=await Bun.file(join(root,role,'preflight.json')).json();
 if(!Bun.deepEquals(JSON.parse(snapshot),expected.afterSdk))throw Error('Actual client-open logical state differs from CPU preflight');
 output.actualClientOpen=JSON.parse(snapshot);await save();
 for(const [index,request] of plan.requests.entries()){
  if(request.idleMs){
   output.transitions.push({event:'idle-start',at:Date.now(),durationMs:request.idleMs,nativeChildren:structuredClone(scope.descendantEvents)});await save();
   await new Promise(resolve=>setTimeout(resolve,request.idleMs));
   output.transitions.push({event:'idle-end',at:Date.now(),nativeChildren:structuredClone(scope.descendantEvents)});await save();
  }
  await session.run(request.caseId);
  const reply=JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await Bun.file(join(session.processIdentity.directory,`${index+1}.reply.json.gz`)).bytes())));
  const result=reply.response.result;
  output.results.push({caseId:request.caseId,...result});await save();
  console.log(JSON.stringify({event:index===0?'first-response':'response',caseId:request.caseId,coverage:result.coverage,semantic:result.raw?.verification?.semantic}));
 }
}catch(error){output.error=String(error);process.exitCode=1;}
finally{
 await scope.stopSampling();try{await session?.close();}finally{await scope.close();}
 output.samples=scope.samples;output.nativeChildren=scope.descendantEvents;output.resourceErrors=scope.errors;
 await save();
}
