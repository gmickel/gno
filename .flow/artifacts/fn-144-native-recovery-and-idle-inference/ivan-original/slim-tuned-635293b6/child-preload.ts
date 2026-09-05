/** Actual child-native evidence. Never imported by the public parent. */
import {appendFileSync} from 'node:fs'; // Native abort may bypass asynchronous flush.
const root=process.env.GNO_ORIGINAL_QA_ROOT,path=process.env.GNO_ORIGINAL_QA_CAPTURE;
if(!root||!path)throw Error('Owned child capture required');
const emit=(event:unknown)=>appendFileSync(path,JSON.stringify({pid:process.pid,event})+'\n',{mode:0o600});
emit({kind:'child-start',parentPid:process.ppid});
const {ModelManager}=await import(`${root}/source/src/llm/nodeLlamaCpp/lifecycle.ts`);
const llama=ModelManager.prototype.getLlama,load=ModelManager.prototype.loadModel;
ModelManager.prototype.getLlama=async function(...args:unknown[]) {const value=await llama.apply(this,args);emit({kind:'actual-backend',gpu:value.gpu});return value;};
ModelManager.prototype.loadModel=async function(...args:unknown[]) {emit({kind:'model-load-start',args});const value=await load.apply(this,args);emit({kind:'model-load-result',ok:value.ok,uri:value.ok?value.value.uri:null});return value;};
for(const [module,name,method] of [['generation','NodeLlamaCppGeneration','generate'],['rerank','NodeLlamaCppRerank','rerank'],['embedding','NodeLlamaCppEmbedding','embed'],['embedding','NodeLlamaCppEmbedding','embedBatch']]) {
 const Type=(await import(`${root}/source/src/llm/nodeLlamaCpp/${module}.ts`))[name],original=Type.prototype[method];
 Type.prototype[method]=async function(...args:unknown[]) {emit({kind:'native-input',role:module,method,modelUri:this.modelUri,args});const value=await original.apply(this,args);emit({kind:'native-output',role:module,method,modelUri:this.modelUri,result:value});return value;};
}
