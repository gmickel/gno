/** Transparent forwarding at the JS native-evaluation iterator boundary. */
export function observeIterator(iterator:any,emit:(event:any)=>void){
 let id=0;
 const invoke=(method:'next'|'return'|'throw',args:unknown[])=>{
  const sequence=++id;
  let pending:any;
  try{pending=Reflect.apply(iterator[method],iterator,args);}catch(error){emit({kind:'evaluation-error',id:sequence,method,error:String(error)});throw error;}
  emit({kind:'evaluation-pending',id:sequence,method});
  return Promise.resolve(pending).then(result=>{emit({kind:'evaluation-end',id:sequence,method,result});return result;},error=>{emit({kind:'evaluation-error',id:sequence,method,error:String(error)});throw error;});
 };
 const wrapper={next:(...args:unknown[])=>invoke('next',args),return:(...args:unknown[])=>invoke('return',args),throw:(...args:unknown[])=>invoke('throw',args),[Symbol.asyncIterator](){return wrapper;}};
 return wrapper;
}
