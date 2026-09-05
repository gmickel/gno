import {appendFileSync,realpathSync} from 'node:fs';
import {wrap} from './observer';
const source=process.env.GNO_CANCEL_QA_SOURCE,log=process.env.GNO_CANCEL_QA_PHASE;
if(source&&log&&realpathSync(process.argv[1]!)===`${source}/src/llm/native-worker/entry.ts`){
 for(let i=process.execArgv.length-1;i>=0;i--)if(process.execArgv[i]==='--preload'&&process.execArgv[i+1]===import.meta.path)process.execArgv.splice(i,2);
 const emit=(event:any)=>appendFileSync(log,JSON.stringify({pid:process.pid,at:Date.now(),...event})+'\n',{mode:0o600});
 const ids=new WeakMap<object,number>(),uris=new WeakMap<object,string>();let counter=0;
 const id=(m:any)=>{if(!m)return null;if(!ids.has(m))ids.set(m,++counter);return ids.get(m);};
 const native=await import(Bun.resolveSync('node-llama-cpp',`${source}/package.json`));
 const desc=Object.getOwnPropertyDescriptor(native.LlamaModel.prototype,'dispose');
 if(!desc?.writable||typeof desc.value!=='function')throw Error('Writable JS model.dispose required');
 native.LlamaModel.prototype.dispose=wrap(desc.value,(model:any,args:any[])=>{const token={modelId:id(model),uri:uris.get(model)};emit({kind:'dispose-start',...token});return token;},(token:any,ok:boolean,error:any)=>emit({kind:'dispose-end',...token,ok,...(!ok?{error:String(error)}:{})}));
 const {ModelManager}=await import(`${source}/src/llm/nodeLlamaCpp/lifecycle.ts`);
 ModelManager.prototype.loadModel=wrap(ModelManager.prototype.loadModel,(_:any,args:any[])=>({uri:args[1],type:args[2]}),(token:any,ok:boolean,value:any)=>{if(ok&&value.ok){uris.set(value.value.model,token.uri);emit({kind:'load-return',...token,modelId:id(value.value.model)});}else emit({kind:'load-error',...token,error:String(value)});});
 const {NativeDispatcher}=await import(`${source}/src/llm/native-worker/dispatcher.ts`);
 NativeDispatcher.prototype.execute=wrap(NativeDispatcher.prototype.execute,(self:any,args:any[])=>({self,request:args[0]}),(token:any,ok:boolean,value:any)=>{const m=token.self.manager;emit({kind:'request-end',request:token.request,ok,models:[...m.models].map(([uri,v]:any)=>({uri,modelId:id(v.model),loaded:m.isLoaded(uri)})),leases:m.modelLeases?[...m.modelLeases]:null,retiring:m.retiringModels?[...m.retiringModels.keys()]:null,files:[...token.self.files],ports:[...token.self.ports.keys()]});});
}

