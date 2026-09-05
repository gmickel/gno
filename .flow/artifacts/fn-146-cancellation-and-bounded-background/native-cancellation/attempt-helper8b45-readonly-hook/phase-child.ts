// Observational addon boundary only; no delay or inference-argument changes.
import {appendFileSync,realpathSync} from 'node:fs'; // Synchronous private phase log has no Bun equivalent.
const source=process.env.GNO_CANCEL_QA_SOURCE;
const log=process.env.GNO_CANCEL_QA_PHASE;
if(source&&log&&realpathSync(process.argv[1]!)===`${source}/src/llm/native-worker/entry.ts`){
 for(let i=process.execArgv.length-1;i>=0;i--)if(process.execArgv[i]==='--preload'&&process.execArgv[i+1]===import.meta.path)process.execArgv.splice(i,2);
 let current:any;let serial=0;
 const emit=(event:unknown)=>appendFileSync(log,JSON.stringify({pid:process.pid,at:Date.now(),event})+'\n',{mode:0o600});
 const {NativeDispatcher}=await import(`${source}/src/llm/native-worker/dispatcher.ts`);
 const execute=NativeDispatcher.prototype.execute;
 NativeDispatcher.prototype.execute=async function(request:any,...args:any[]){current=request;emit({kind:'request-start',request});try{return await execute.call(this,request,...args);}finally{emit({kind:'request-end',request});current=undefined;}};
 const {ModelManager}=await import(`${source}/src/llm/nodeLlamaCpp/lifecycle.ts`);
 const load=ModelManager.prototype.loadModel;const seen=new WeakSet();
 ModelManager.prototype.loadModel=async function(...args:any[]){
  const result=await load.apply(this,args);
  if(result.ok&&!seen.has(result.value.model)){
   const model=result.value.model;seen.add(model);const create=model.createContext;
   model.createContext=async function(...input:any[]){
    const context=await create.apply(this,input);const addon=context._ctx;const decode=addon.decodeBatch;
    addon.decodeBatch=function(...input:any[]){
     const id=++serial;const request=current;const pending=decode.apply(this,input);
     emit({kind:'decode-pending',id,request});
     return Promise.resolve(pending).then(value=>{emit({kind:'decode-end',id,request});return value;},error=>{emit({kind:'decode-error',id,request,error:String(error)});throw error;});
    };return context;
   };
  }return result;
 };
}
