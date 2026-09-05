import {appendFileSync} from "node:fs"; // Bun has no synchronous termination-safe append API.
process.execArgv=process.execArgv.filter((arg,index,args)=>arg!==import.meta.filename && !(arg==="--preload" && args[index+1]===import.meta.filename));
const source=process.env.GNO_HASH_SOURCE!;
const log=`${process.env.GNO_HASH_DIAGNOSTIC_DIRECTORY}/${process.pid}.jsonl`;
let current:unknown=null;
const record=(value:Record<string,unknown>)=>appendFileSync(log,JSON.stringify({pid:process.pid,time:Date.now(),...value})+"\n",{mode:0o600});
const {NativeDispatcher}=await import(`${source}/src/llm/native-worker/dispatcher.ts`);
const execute=NativeDispatcher.prototype.execute;
NativeDispatcher.prototype.execute=async function(request:any){current={requestId:request.requestId,op:request.op};record({event:"request-start",request:current});try{return await execute.call(this,request);}finally{record({event:"request-end",request:current});current=null;}};
const file=Bun.file;
Bun.file=function(path:any,...args:any[]){
 const value=Reflect.apply(file,Bun,[path,...args]);
 if(typeof path==="string" && path.startsWith("/home/gordon/.cache/gno/models/") && path.endsWith(".gguf")){
  const stream=value.stream.bind(value);
  Object.defineProperty(value,"stream",{value:(...parameters:any[])=>{
   const started=performance.now(),request=current,stack=new Error("GGUF stream caller").stack;
   let bytes=0;record({event:"stream-start",path,request,stack});
   return stream(...parameters).pipeThrough(new TransformStream({transform(chunk,controller){bytes+=chunk.byteLength;controller.enqueue(chunk);},flush(){record({event:"stream-end",path,request,bytes,durationMs:performance.now()-started});}}));
  }});
 }
 return value;
} as typeof Bun.file;
