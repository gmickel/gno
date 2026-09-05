/** Plain SDK timing screen. No capture preload, model patch, retry or timeout override. */
interface Plan {
  role: "baseline" | "candidate";
  sourceRoot: string;
  configPath: string;
  dbPath: string;
  cacheDir: string;
  outputPath: string;
  caseId: string;
  query: string;
  options: Record<string, unknown>;
  mode: "serial" | "concurrent";
  count: number;
  concurrency: number;
  productIdentity: Record<string, unknown>;
}

const driverStartedAt = performance.now();
const plan = (await Bun.file(process.argv[2]!).json()) as Plan;
if (
  !["baseline", "candidate"].includes(plan.role) ||
  !["serial", "concurrent"].includes(plan.mode) ||
  !Number.isSafeInteger(plan.count) ||
  plan.count < 1 ||
  plan.count > 24 ||
  !Number.isSafeInteger(plan.concurrency) ||
  plan.concurrency < 1 ||
  plan.concurrency > 4 ||
  plan.count % plan.concurrency !== 0 ||
  (plan.mode === "serial" && plan.concurrency !== 1)
) throw new Error("Invalid preregistered burst plan");
if (await Bun.file(plan.outputPath).exists())
  throw new Error("Refusing to replace an existing observation");
const config = await Bun.file(plan.configPath).json();
const result: Record<string, unknown> = {
  plan,
  pid: process.pid,
  bunVersion: Bun.version,
  driverStartedAt,
  calls: [],
  phases: [],
};
const calls = result.calls as Array<Record<string, unknown>>;
const phases = result.phases as Array<Record<string, unknown>>;
let client: {
  query(query: string, options: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
} | undefined;
let failed = false;
async function invoke(index: number, phase: string) {
  const startedAt = performance.now();
  try {
    const response = await client!.query(plan.query, plan.options);
    const endedAt = performance.now();
    const call = { index, phase, startedAt, endedAt, durationMs: endedAt - startedAt, ok: true, response };
    calls.push(call);
    return call;
  } catch (error) {
    const endedAt = performance.now();
    failed = true;
    const call = { index, phase, startedAt, endedAt, durationMs: endedAt - startedAt, ok: false, error: String(error) };
    calls.push(call);
    return call;
  }
}
try {
  const { createGnoClient } = await import(`${plan.sourceRoot}/src/sdk/client.ts`);
  client = await createGnoClient({ config, dbPath: plan.dbPath, cacheDir: plan.cacheDir, downloadPolicy: { offline: true, allowDownload: false } });
  result.clientReadyAt = performance.now();
  // First call includes model/child acquisition; outer supervisor measures process spawn too.
  const cold = await invoke(-1, "first-request");
  result.firstResponseFromDriverStartMs = cold.endedAt - driverStartedAt;
  console.log(JSON.stringify({ event: "first-response", pid: process.pid, at: Date.now(), driverElapsedMs: result.firstResponseFromDriverStartMs, ok: cold.ok }));
  await Bun.write(plan.outputPath, JSON.stringify(result));
  if (!cold.ok) throw new Error("First request failed; no warm timing substitution");
  const startedAt = performance.now();
  for (let wave = 0; wave < plan.count / plan.concurrency; wave++) {
    const indices = Array.from({ length: plan.concurrency }, (_, slot) => wave * plan.concurrency + slot);
    await Promise.all(indices.map((index) => invoke(index, plan.mode)));
  }
  const endedAt = performance.now();
  const measured = calls.filter((call) => call.phase === plan.mode);
  phases.push({ mode: plan.mode, offered: plan.count, settled: measured.length, completed: measured.filter((call) => call.ok).length, startedAt, endedAt, makespanMs: endedAt - startedAt, throughputCompletedPerSecond: measured.filter((call) => call.ok).length * 1000 / (endedAt - startedAt) });
} catch (error) {
  failed = true;
  result.error = String(error);
} finally {
  const closeStartedAt = performance.now();
  try { await client?.close(); } catch (error) { failed = true; result.closeError = String(error); }
  result.closeDurationMs = performance.now() - closeStartedAt;
  result.totalDriverMs = performance.now() - driverStartedAt;
  calls.sort((a, b) => Number(a.index) - Number(b.index));
  await Bun.write(plan.outputPath, JSON.stringify(result, null, 2));
}
process.exitCode = failed ? 1 : 0;
