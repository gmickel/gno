/** Actual public REST/HTTP MCP server, with a transparent real-factory observation seam. */
import { appendFileSync } from "node:fs"; // Termination-safe append lacks a Bun equivalent.
import { createShutdownObserver, forwardObservedFactory } from "./fn146.5-shutdown-observer";
const settings = JSON.parse(process.env.GNO_SURFACE_QA!);
const emit = (row: unknown) => appendFileSync(`${settings.root}/shutdown.jsonl`, JSON.stringify({ parentPid: process.pid, row }) + "\n");
const failed = (error: unknown) => { process.stderr.write(`QA_SHUTDOWN_CAPTURE_FAILED ${String(error)}\n`); process.exitCode = 1; };
const observer = createShutdownObserver(emit, failed);
const { startBackgroundRuntime } = await import(`${settings.source}/src/serve/background-runtime.ts`);
const { startServer } = await import(`${settings.source}/src/serve/server.ts`);
const options = JSON.parse(Bun.argv[2]);
const result = await startServer(options, {
  startBackgroundRuntime: forwardObservedFactory(startBackgroundRuntime, (result: any) => { if (result.success) observer.observeRuntime(result.runtime); }, failed),
});
if (!result.success) { console.error(JSON.stringify(result)); process.exitCode = 1; }
