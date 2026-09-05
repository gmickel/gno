// Writable JS async-iterator observation only. Native binding methods untouched.
import {appendFileSync,realpathSync} from 'node:fs'; // Synchronous private phase log has no Bun equivalent.
import {observeIterator} from './iterator-observer';
const source=process.env.GNO_CANCEL_QA_SOURCE;const log=process.env.GNO_CANCEL_QA_PHASE;
if(source&&log&&realpathSync(process.argv[1]!)===`${source}/src/llm/native-worker/entry.ts`){
 for(let i=process.execArgv.length-1;i>=0;i--)if(process.execArgv[i]==='--preload'&&process.execArgv[i+1]===import.meta.path)process.execArgv.splice(i,2);
 let current:any;let evaluation=0;
 const emit=(event:unknown)=>appendFileSync(log,JSON.stringify({pid:process.pid,at:Date.now(),event})+'\n',{mode:0o600});
 const {NativeDispatcher}=await import(`${source}/src/llm/native-worker/dispatcher.ts`);
 const execute=NativeDispatcher.prototype.execute;
 NativeDispatcher.prototype.execute=async function(request:any,...args:any[]){current=request;emit({kind:'request-start',request});try{return await execute.call(this,request,...args);}finally{emit({kind:'request-end',request});current=undefined;}};
 const native=await import(Bun.resolveSync('node-llama-cpp',`${source}/package.json`));
 const prototype=native.LlamaContextSequence.prototype;const descriptor=Object.getOwnPropertyDescriptor(prototype,'evaluate');
 if(!descriptor?.writable||typeof descriptor.value!=='function')throw Error('JS evaluation observer requires writable original method');
 const original=descriptor.value;
 prototype.evaluate=function(...args:any[]){const iterator=original.apply(this,args);const request=current;const evaluationId=++evaluation;return observeIterator(iterator,event=>emit({...event,evaluationId,request}));};
}
