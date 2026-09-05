import {mkdir} from "node:fs/promises"; // Bun has no directory-creation API.
const plan = await Bun.file(process.argv[2]!).json();
const {createNativeAcceptanceSession} = await import(`${plan.sourceRoot}/evals/acceptance/native-adapter.ts`);
const directory = `${plan.outputPath}.children`;
await mkdir(directory,{mode:0o700});
const config = await Bun.file(plan.configPath).json();
const manifest = plan.manifest;
const request = {manifest,caseId:plan.caseId,query:plan.query,operation:"hybrid",options:plan.options,expectedBackend:"cuda"};
const output: Record<string,unknown> = {plan,pid:process.pid,results:[]};
let session;
try {
 session = await createNativeAcceptanceSession(manifest,{config,dbPath:plan.dbPath,cacheDir:plan.cacheDir},{directory});
 for(const phase of ["first","warm"]){
   const response=await session.run(request);
   (output.results as unknown[]).push({phase,...response});
   await Bun.write(plan.outputPath,JSON.stringify(output));
   if(response.coverage!=="complete")process.exitCode=1;
 }
}catch(error){output.error=String(error);process.exitCode=1;}
finally{await session?.close();await Bun.write(plan.outputPath,JSON.stringify(output,null,2));}
