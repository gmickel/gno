import {mkdir} from 'node:fs/promises';
import {installPhaseBridge} from './phase-parent';
const plan=await Bun.file(process.argv[2]!).json(),source=plan.sourceRoot;
const root=plan.outputPath.slice(0,plan.outputPath.lastIndexOf('/'));
if(await Bun.file(plan.outputPath).exists())throw Error('Existing result refused');
const results:any[]=[],events:any[]=[];const save=()=>Bun.write(plan.outputPath,JSON.stringify({results,events},null,2));
const restore=installPhaseBridge(source,`${root}/phases.jsonl`);
const {installParentCapture}=await import(`${source}/evals/acceptance/parent-capture.ts`);
const {projectAcceptance}=await import(`${source}/evals/acceptance/native-adapter.ts`);
const {createGnoClient}=await import(`${source}/src/sdk/client.ts`);
await mkdir(`${root}/capture`,{mode:0o700});
const capture=await installParentCapture(crypto.randomUUID(),plan.manifest.models,`${root}/capture`,undefined,(e:any)=>events.push({at:Date.now(),kind:'child',event:e}));
const client:any=await createGnoClient({...plan.init,downloadPolicy:{offline:true,allowDownload:false}});
const {captureContextEvidenceSnapshot}=await import(`${source}/src/core/context-evidence.ts`);
const expected=await Bun.file(`${root}/preflight.json`).json();
const opened=await captureContextEvidenceSnapshot(client.store,'default',['probe']);
if(!Bun.deepEquals(opened,expected.afterSdk))throw Error('Preflight snapshot mismatch');
let port:any;
async function publicCall(req:any){
 capture.begin(req.caseId);let raw:any=null,failure:string|undefined;
 try{raw=await(req.operation==='verified-ask'?client.ask(req.query,{...req.options,verify:true,explain:true}):client.query(req.query,{...req.options,explain:true}));}catch(e){failure=String(e);}
 const receipt=structuredClone(capture.finish());
 const projected=await projectAcceptance(req,raw,receipt,async(uri:string)=>{const doc=await client.get(uri);return {content:doc.content,sourceHash:doc.source.sourceHash};},failure);
 results.push({label:req.caseId,raw,failure,receipt,projected});await save();
}
async function embed(label:string){capture.begin(label);let output:any,failure:any;try{output=await port.embed(plan.embeddingInput);}catch(e){failure=String(e);}const receipt=structuredClone(capture.finish());results.push({label,output,failure,receipt});await save();}
try{
 for(const req of plan.requests.slice(0,4))await publicCall(req);
 capture.begin('retained-port-init');const made=await client.llm.createEmbeddingPort(undefined,{egressCollections:['probe'],policy:{offline:true,allowDownload:false}});if(!made.ok)throw Error(JSON.stringify(made.error));port=made.value;const init=await port.init();results.push({label:'retained-port-init',output:init,receipt:structuredClone(capture.finish())});await save();
 const start=performance.now();for(let i=0;i<30;i++){const wait=start+i*100-performance.now();if(wait>0)await new Promise(r=>setTimeout(r,wait));await embed(`paced-${i}`);}
 for(const req of plan.requests.slice(4))await publicCall(req);
 await embed('retained-final');
}catch(e){events.push({kind:'driver-error',error:String(e)});process.exitCode=1;}
finally{await port?.dispose();await client.close();capture.restore();restore();events.push({kind:'closed',at:Date.now()});await save();}

