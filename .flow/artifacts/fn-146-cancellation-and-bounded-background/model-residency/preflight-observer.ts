import {wrap} from './observer';
import {strict as assert} from 'node:assert';
const source=process.argv[2];const n=await import(Bun.resolveSync('node-llama-cpp',`${source}/package.json`));const d=Object.getOwnPropertyDescriptor(n.LlamaModel.prototype,'dispose');assert.equal(d?.writable,true);assert.equal(typeof d?.value,'function');
const receiver={},arg={},value={},failure=Error('expected');let observed:any;
const good=wrap(function(this:any,a:any){assert.equal(this,receiver);assert.equal(a,arg);return Promise.resolve(value);},(self:any,args:any[])=>{assert.equal(self,receiver);assert.equal(args[0],arg);return arg;},(token:any,ok:any,v:any)=>{assert.equal(token,arg);assert.equal(ok,true);observed=v;});
assert.equal(await good.call(receiver,arg),value);assert.equal(observed,value);
for(const async of [false,true]){const bad=wrap(()=>{if(async)return Promise.reject(failure);throw failure;},()=>arg,(t:any,ok:any,e:any)=>{assert.equal(t,arg);assert.equal(ok,false);assert.equal(e,failure);});try{await bad();assert.fail();}catch(e){assert.equal(e,failure);}}
console.log(JSON.stringify({writableJsDispose:true,receiverArgumentsValueErrorIdentity:true,nativeLoadCalls:0}));

