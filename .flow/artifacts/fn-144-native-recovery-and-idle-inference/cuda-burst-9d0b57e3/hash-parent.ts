const spawn = Bun.spawn;
Bun.spawn = function(options: any, ...rest: any[]) {
 const entry = options && !Array.isArray(options) ? options.cmd?.find((arg:unknown)=>typeof arg==="string" && arg.endsWith("/src/llm/native-worker/entry.ts")) : undefined;
 if(entry) return spawn({...options,cmd:[options.cmd[0],"--preload",`${import.meta.dir}/hash-child.ts`,...options.cmd.slice(1)],env:{...options.env,GNO_HASH_DIAGNOSTIC_DIRECTORY:process.env.GNO_HASH_DIAGNOSTIC_DIRECTORY,GNO_HASH_SOURCE:entry.slice(0,-"/src/llm/native-worker/entry.ts".length)}});
 return Reflect.apply(spawn,Bun,[options,...rest]);
} as typeof Bun.spawn;
