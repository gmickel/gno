/** Owned original-scope proof only; intercept the exact selected native entry. */
import {appendFileSync} from 'node:fs'; // Termination-safe synchronous evidence.
const root=process.env.GNO_ORIGINAL_QA_ROOT;
if(!root)throw Error('Owned QA root required');
const spawn=Bun.spawn;
Bun.spawn=function(...args:unknown[]) {
 const options=args[0] as {cmd?:string[],env?:Record<string,string>};
 if(options?.cmd?.[2]===`${root}/source/src/llm/native-worker/entry.ts`) {
  const config=JSON.parse(options.cmd[3]);
  const evidence=`${root}/evidence/${process.env.GNO_ORIGINAL_QA_PHASE}-parent${process.pid}-generation${config.generation}.native.jsonl`;
  const modified={...options,cmd:[options.cmd[0],options.cmd[1],'--preload',`${root}/child-preload.ts`,...options.cmd.slice(2)],env:{...options.env,GNO_ORIGINAL_QA_ROOT:root,GNO_ORIGINAL_QA_CAPTURE:evidence}};
  const child=spawn.call(Bun,modified as never);
  appendFileSync(`${root}/evidence/children.jsonl`,JSON.stringify({phase:process.env.GNO_ORIGINAL_QA_PHASE,parentPid:process.pid,pid:child.pid,config,evidence})+'\n');
  return child;
 }
 return spawn.apply(Bun,args as never);
} as typeof Bun.spawn;
