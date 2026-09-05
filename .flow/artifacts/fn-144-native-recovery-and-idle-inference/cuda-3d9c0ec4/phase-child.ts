// Scratch phase-only instrumentation; never imported into a live/native-free parent.
import { appendFileSync } from 'node:fs';
const source = process.env.QA_PHASE_SOURCE!;
const file = `${process.env.QA_PHASE_DIRECTORY}/${process.pid}.jsonl`;
// Do not propagate worker-only capture preloads into nodecpp binary-test forks.
const workerPreloads = new Set([import.meta.filename, `${source}/evals/acceptance/native-child-preload.ts`]);
process.execArgv = process.execArgv.filter((arg, index, args) => !workerPreloads.has(arg) && !(arg === "--preload" && workerPreloads.has(args[index + 1])));
const config = JSON.parse(process.argv[2]);
const {NativeDispatcher} = await import(`${source}/src/llm/native-worker/dispatcher.ts`);
const {ModelManager} = await import(`${source}/src/llm/nodeLlamaCpp/lifecycle.ts`);
const {GuardedSimulatorSession} = await import(`${source}/src/llm/nodeLlamaCpp/simulator-session.ts`);
const {SimulatorModelHandle} = await import(`${source}/src/llm/nodeLlamaCpp/simulator-handle.ts`);
const ids = new WeakMap<object,number>(); let nextId=0; let nextEvent=0; let request:number|null=null;
function id(value: object) { if(!ids.has(value))ids.set(value,++nextId);return ids.get(value); }
function record(event:Record<string,unknown>) { appendFileSync(file,JSON.stringify({time:Date.now(),pid:process.pid,parentPid:process.ppid,generation:config.generation,...event})+'\n',{mode:0o600}); }
record({event:'phase-ready'});
const execute=NativeDispatcher.prototype.execute;
NativeDispatcher.prototype.execute=async function(input:any){request=input.requestId;record({event:'request-start',requestId:request,op:input.op});try{return await execute.call(this,input);}finally{record({event:'request-end',requestId:request,op:input.op});request=null;}};
function wrap(prototype:any,name:string,kind:string) {
 const previous=prototype[name];
 prototype[name]=async function(...args:any[]){
  const eventId=++nextEvent,requestId=request,ownerId=id(this);
  const arg=args[0]; const parameters=arg&&typeof arg==='object'?Object.fromEntries(Object.entries(arg).filter(([key])=>['gpuLayers','contextSize','batchSize','sequences','isEmbeddingContext','flashAttention','swaFullCache','useMmap','kvCacheKeyType','kvCacheValueType'].includes(key))):undefined;
  record({event:'start',kind,eventId,requestId,ownerId,parameters});
  try {const value=await previous.apply(this,args);record({event:'end',kind,eventId,requestId,ownerId,backend:kind==='backend-init'?value.gpu:undefined,modelId:kind==='simulator-model-load'?id(value.model):undefined});return value;}
  catch(error){record({event:'error',kind,eventId,requestId,ownerId,error:String(error)});throw error;}
 };
}
for(const [name,kind] of [['getLlama','backend-init'],['loadModel','actual-model-load'],['disposeAll','actual-backend-dispose']] as const)wrap(ModelManager.prototype,name,kind);
for(const [name,kind] of [['estimateModelResources','simulator-model-estimate'],['estimateContextResources','simulator-context-estimate'],['loadModel','simulator-model-load'],['dispose','simulator-session-dispose']] as const)wrap(GuardedSimulatorSession.prototype,name,kind);
wrap(SimulatorModelHandle.prototype,'dispose','simulator-handle-dispose');
process.on('exit',code=>record({event:'process-exit',code}));
