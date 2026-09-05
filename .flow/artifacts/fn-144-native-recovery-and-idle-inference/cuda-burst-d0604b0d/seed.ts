const plan = await Bun.file(process.argv[2]!).json();
if (await Bun.file(plan.outputPath).exists()) throw new Error("Seed receipt already exists");
const {createGnoClient} = await import(`${plan.sourceRoot}/src/sdk/client.ts`);
const config = await Bun.file(plan.configPath).json();
let client;
const receipt: Record<string, unknown> = {plan, pid:process.pid};
try {
  client = await createGnoClient({config, dbPath:plan.dbPath, cacheDir:plan.cacheDir, downloadPolicy:{offline:true,allowDownload:false}});
  if (!plan.skipUpdate) receipt.update = await client.update();
  receipt.embed = await client.embed(plan.embedOptions ?? {});
} catch(error) { receipt.error=String(error); process.exitCode=1; }
finally { await client?.close(); await Bun.write(plan.outputPath,JSON.stringify(receipt,null,2)); }
