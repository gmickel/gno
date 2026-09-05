/** Selected-source shutdown class seams, loaded only inside the owned QA parent. */
import { createShutdownObserver } from "./fn146.5-shutdown-observer";
export async function installShutdownBindings(source: string, emit: (row: unknown) => void, failed: (error: unknown) => void) {
  const observer = createShutdownObserver(emit, failed);
  const budget = await import(`${source}/src/core/shutdown-budget.ts`);
  emit({ kind: "shutdown-budget-constants", drainMs: budget.SHUTDOWN_DRAIN_MS, abortMs: budget.SHUTDOWN_ABORT_MS, exitMs: budget.SHUTDOWN_EXIT_MS, detachedParentStopGraceMs: budget.RESIDENT_STOP_GRACE_MS });
  const bindings = [
    ["src/store/sqlite/adapter.ts", "SqliteAdapter", ["beginShutdown", "fenceForShutdown", "close"]],
    ["src/serve/resident-admission.ts", "AdmissionController", ["stop", "drain", "cancel"]],
    ["src/serve/resident-background-work.ts", "ResidentBackgroundWork", ["drain", "cancel"]],
    ["src/core/job-manager.ts", "JobManager", ["stop", "shutdown", "cancel", "failUnfinished"]],
    ["src/llm/nodeLlamaCpp/adapter.ts", "LlmAdapter", ["dispose"]],
    ["src/llm/native-worker/client.ts", "NativeWorkerClient", ["dispose", "retire"]],
  ] as const;
  for (const [path, name, methods] of bindings) {
    const module = await import(`${source}/${path}`);
    observer.observe(module[name].prototype, name, [...methods]);
    emit({ kind: "shutdown-source-pin", path, sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(`${source}/${path}`).bytes()).digest("hex") });
  }
  for (const path of ["src/serve/resident-shutdown.ts", "src/core/shutdown-budget.ts", "src/llm/native-worker/owned-exit.ts", "src/serve/resident-runtime.ts", "src/serve/embed-scheduler.ts"]) emit({ kind: "shutdown-source-pin", path, sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(`${source}/${path}`).bytes()).digest("hex") });
  return observer;
}
