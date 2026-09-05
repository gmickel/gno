import {captureContextArguments,captureContextModelArguments,captureArguments} from './freeze/accepted-package/package/evals/acceptance/capture-contract.ts';
const controller=new AbortController();
const shapes=[
 {contextSize:2048,batchSize:undefined,threads:6,createSignal:controller.signal,ignoreMemorySafetyChecks:undefined,_embeddings:true},
 {contextSize:6400,createSignal:controller.signal},
 {contextSize:6400,batchSize:undefined,threads:6,createSignal:controller.signal,ignoreMemorySafetyChecks:undefined,_embeddings:true,_ranking:true},
 {contextSize:2048,createSignal:controller.signal},
];
const records=shapes.map(shape=>({telemetry:captureContextArguments([shape])}));
const embeddingOuter=[{contextSize:2048,createSignal:controller.signal},{contextSize:2048,threads:6,createSignal:controller.signal}];
const models=embeddingOuter.map(shape=>captureArguments(captureContextModelArguments([shape])));
if(shapes.some(shape=>shape.createSignal!==controller.signal))throw Error('Signal identity changed');
let unknownRejected=false;try{captureContextArguments([{contextSize:new Date()}]);}catch{unknownRejected=true;}
if(!unknownRejected)throw Error('Unknown context object accepted');
await Bun.write(`${import.meta.dir}/context-preflight.json`,JSON.stringify({nativeExecution:false,unknownRejected,records,models},null,2));
console.log(JSON.stringify({nativeExecution:false,shapes:records.length,unknownRejected}));
