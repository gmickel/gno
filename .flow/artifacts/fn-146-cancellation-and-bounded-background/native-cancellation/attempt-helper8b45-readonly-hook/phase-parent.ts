// Installed before canonical parent capture so its validated launch stays intact.
export function installPhaseBridge(source:string,log:string){
 const spawn=Bun.spawn;
 Bun.spawn=function(first:any,...rest:any[]){
  if(!first?.cmd?.includes(`${source}/src/llm/native-worker/entry.ts`))return Reflect.apply(spawn,Bun,[first,...rest]);
  return Reflect.apply(spawn,Bun,[{...first,cmd:[first.cmd[0],first.cmd[1],'--preload',`${import.meta.dir}/phase-child.ts`,...first.cmd.slice(2)],env:{...first.env,GNO_CANCEL_QA_SOURCE:source,GNO_CANCEL_QA_PHASE:log}}]);
 } as typeof Bun.spawn;
 return ()=>{Bun.spawn=spawn;};
}
