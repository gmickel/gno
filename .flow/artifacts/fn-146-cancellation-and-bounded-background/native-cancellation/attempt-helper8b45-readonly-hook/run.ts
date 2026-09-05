// One declared real-native stratum. No retries or inference-parameter changes.
import {mkdir} from 'node:fs/promises'; // Bun has no directory API.
import {readFileSync} from 'node:fs'; // Synchronous observational phase polling.
import {observeOwnership} from './ownership-observer';
import {installPhaseBridge} from './phase-parent';
const root=import.meta.dir;
if(await Bun.file(`${root}/result.json`).exists())throw Error('Existing native observation refused');
const source=`${root}/freeze/accepted-package/package`;
const fixture=await Bun.file(`${root}/fixture.json`).json();
const init=await Bun.file(`${root}/init.json`).json();
const events:any[]=[];const results:any[]=[];
const emit=(event:any)=>{events.push({at:Date.now(),...event});};
const checkpoint=()=>Bun.write(`${root}/result.json`,JSON.stringify({events,results},null,2));
const restorePhase=installPhaseBridge(source,`${root}/phases.jsonl`);
const {installParentCapture}=await import(`${source}/evals/acceptance/parent-capture.ts`);
const {createGnoClient}=await import(`${source}/src/sdk/client.ts`);
await mkdir(`${root}/capture`,{mode:0o700});
const capture=await installParentCapture(crypto.randomUUID(),fixture.models,`${root}/capture`,undefined,e=>emit({kind:'child',value:e}));
const client:any=await createGnoClient({...init,downloadPolicy:{offline:true,allowDownload:false}});
const {captureContextEvidenceSnapshot}=await import(`${source}/src/core/context-evidence.ts`);
const expected=await Bun.file(`${root}/preflight.json`).json();
const opened=await captureContextEvidenceSnapshot(client.store,'default',['probe']);
if(!Bun.deepEquals(opened,expected.afterSdk))throw Error('Native client-open logical snapshot changed from CPU preflight');
const worker=client.llm.worker;
const observe=()=>observeOwnership(worker);
let previous='';const timer=setInterval(()=>{const state=observe();const key=JSON.stringify({...state,atMonotonicMs:0});if(key!==previous){previous=key;emit({kind:'ownership',state});}},1);
const outcome=async(label:string,promise:Promise<any>)=>{try{const value=await promise;emit({kind:'caller-settled',label,value,state:observe()});return {resolved:true,value};}catch(error:any){const value={name:error?.name,message:error?.message,code:error?.code,cause:error?.cause};emit({kind:'caller-rejected',label,value,state:observe()});return {resolved:false,error:value};}};
const query=()=>client.query(fixture.query,fixture.options);
const poll=async(predicate:()=>boolean,limitMs=10000)=>{const end=performance.now()+limitMs;while(performance.now()<end){if(predicate())return true;await new Promise(r=>setTimeout(r,1));}return false;};
const drained=()=>!worker.owner?.busy&&!worker.owner?.pending.length&&!worker.owner?.waiters.size;
const finish=async(label:string,extra:any)=>{const didDrain=await poll(drained);const receipt=structuredClone(capture.finish());results.push({label,...extra,didDrain,receipt});await checkpoint();};
const activeDecode=(op:string,after:number)=>{
 let rows:any[];try{rows=readFileSync(`${root}/phases.jsonl`,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return undefined;}
 return rows.findLast(row=>row.at>=after&&row.event.kind==='decode-pending'&&row.event.request?.op===op&&!rows.some(end=>end.pid===row.pid&&end.event.id===row.event.id&&['decode-end','decode-error'].includes(end.event.kind)));
};
try{
 capture.begin('control');const control=await outcome('control',query());await finish('control',{control});
 capture.begin('pre-aborted');const pre=new AbortController();pre.abort();const beforeId=worker.requestId;
 const cancelled=await outcome('pre-aborted',client.query(fixture.query,{...fixture.options,signal:pre.signal}));
 const afterId=worker.requestId;const recovery=await outcome('pre-aborted-recovery',query());await finish('pre-aborted',{cancelled,recovery,beforeId,afterId});
 const created=await client.llm.createRerankPort(undefined,{egressCollections:['probe'],policy:{offline:true,allowDownload:false}});if(!created.ok)throw Error(JSON.stringify(created.error));const reranker=created.value;
 capture.begin('queued');const queueStart=Date.now();let primaryDone=false;
 const primary=outcome('queued-primary',reranker.rerank(fixture.rerank.query,fixture.rerank.documents)).finally(()=>{primaryDone=true;});
 const firstActive=await poll(()=>Boolean(activeDecode('rerank',queueStart))||primaryDone);
 let queued:any={exercised:false};
 if(firstActive&&!primaryDone){const controller=new AbortController();const pending=outcome('queued-cancelled',reranker.rerank(fixture.rerank.query,fixture.rerank.documents,{signal:controller.signal}));const found=await poll(()=>worker.owner?.pending.length>=2||primaryDone);const state=observe();const exercised=Boolean(found&&!primaryDone&&worker.owner?.pending.length>=2);emit({kind:'abort',label:'queued',exercised,state});controller.abort();queued={exercised,cancelled:await pending,stateAtAbort:state};}
 const primaryResult=await primary;const queueRecovery=await outcome('queued-recovery',query());await finish('queued',{queued,primary:primaryResult,recovery:queueRecovery});
 for(const op of ['rerank','generate']){
  const label=`active-${op}`;capture.begin(label);let port=reranker;
  if(op==='generate'){const created=await client.llm.createGenerationPort(undefined,{egressCollections:['probe'],policy:{offline:true,allowDownload:false}});if(!created.ok)throw Error(JSON.stringify(created.error));port=created.value;}
  const controller=new AbortController();const at=Date.now();let complete=false;
  const operation=outcome(label,op==='rerank'?port.rerank(fixture.rerank.query,fixture.rerank.documents,{signal:controller.signal}):port.generate(fixture.generation.prompt,fixture.generation.params,{signal:controller.signal})).finally(()=>{complete=true;});
  await poll(()=>Boolean(activeDecode(op,at))||complete);const phase=activeDecode(op,at);const state=observe();const exercised=Boolean(phase&&!complete&&state.busy);
  emit({kind:'abort',label,exercised,phase,state});controller.abort();const cancelled=await operation;
  const stateAfterCaller=observe();emit({kind:'recovery-offered',label,state:stateAfterCaller});const recovery=await outcome(`${label}-recovery`,query());
  await finish(label,{exercised,phase,stateAtAbort:state,stateAfterCaller,cancelled,recovery});
 }
}catch(error){emit({kind:'driver-error',error:String(error)});process.exitCode=1;}
finally{
 clearInterval(timer);await poll(drained);await client.close();capture.restore();restorePhase();emit({kind:'closed',state:observe()});await checkpoint();
}
