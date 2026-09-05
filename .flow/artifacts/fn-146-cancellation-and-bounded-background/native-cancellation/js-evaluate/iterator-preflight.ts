import {observeIterator} from './iterator-observer';
const source=`${import.meta.dir}/freeze/accepted-package/package`;
const native=await import(Bun.resolveSync('node-llama-cpp',`${source}/package.json`));
const descriptor=Object.getOwnPropertyDescriptor(native.LlamaContextSequence.prototype,'evaluate');
if(!descriptor?.writable||typeof descriptor.value!=='function')throw Error('Selected JS method not writable');
const events:any[]=[];const values:any[]=[];const token={token:1};const sent={sent:true};const returned={returned:true};const thrown=new Error('same error');
async function* original(input:any):AsyncGenerator<any,any,any>{if(input!==token)throw Error('Input identity changed');try{values.push(yield input);return 'finished';}finally{values.push('finally');}}
const iterator=observeIterator(original(token),e=>events.push(e));
if(iterator[Symbol.asyncIterator]()!==iterator)throw Error('Async iterator self changed');
if((await iterator.next()).value!==token)throw Error('Yield value changed');
if((await iterator.next(sent)).value!=='finished'||values[0]!==sent)throw Error('next argument changed');
const closing=observeIterator(original(token),e=>events.push(e));await closing.next();const closed=await closing.return(returned);if(closed.value!==returned||!closed.done)throw Error('return argument changed');
const failing=observeIterator(original(token),e=>events.push(e));await failing.next();let actual;try{await failing.throw(thrown);}catch(error){actual=error;}if(actual!==thrown)throw Error('throw identity changed');
const calls:any[]=[];const fake={next(...args:any[]){calls.push({receiver:this,args});return Promise.resolve({value:args[0],done:false});},return(...args:any[]){return Promise.resolve({value:args[0],done:true});},throw(error:any){return Promise.reject(error);}};
const forwarding=observeIterator(fake,e=>events.push(e));await forwarding.next(sent);if(calls[0].receiver!==fake||calls[0].args[0]!==sent)throw Error('Receiver/arguments changed');
await Bun.write(`${import.meta.dir}/iterator-preflight.json`,JSON.stringify({nativeExecution:false,writable:true,nextReturnThrowIdentity:true,asyncIteratorSelf:true,events:events.map(e=>({...e,result:e.result?{done:e.result.done}:undefined}))},null,2));
console.log(JSON.stringify({nativeExecution:false,writable:true,nextReturnThrowIdentity:true,asyncIteratorSelf:true}));
