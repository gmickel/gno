import type { WriteLockHandle } from "../core/file-lock";
/** One finite shutdown clock for the resources owned by a resident runtime. */
import type { JobManager } from "../core/job-manager";
import type { ToolContext } from "../mcp/context";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { ServerContext } from "./context";
import type { EmbedScheduler } from "./embed-scheduler";
import type { AdmissionController } from "./resident-admission";
import type { ResidentBackgroundWork } from "./resident-background-work";
import type { ResidentRuntimeOptions } from "./resident-runtime";

import {
  settlesBy,
  shutdownDuration,
  SHUTDOWN_DRAIN_MS,
  SHUTDOWN_ABORT_MS,
  SHUTDOWN_EXIT_MS,
} from "../core/shutdown-budget";

interface ResidentShutdownResources {
  options: ResidentRuntimeOptions;
  admission: AdmissionController;
  backgroundWork: ResidentBackgroundWork;
  jobManager: JobManager;
  scheduler: EmbedScheduler;
  store: SqliteAdapter;
  watchService: { dispose(): void | Promise<void> };
  context: ServerContext;
  mcpContext: ToolContext;
  modelManager: { disposeAll(): Promise<void> };
  ownerLock: WriteLockHandle;
  stopFindings: () => void;
  stopCapsules: () => Promise<void>;
  closeEvents: () => void | Promise<void>;
  disposeContext: (context: ServerContext) => Promise<void>;
  closeSurface?: () => Promise<unknown>;
  onDeadline: () => void;
}

export async function disposeResidentResources(
  resources: ResidentShutdownResources
): Promise<void> {
  const {
    options,
    admission,
    backgroundWork,
    jobManager,
    scheduler,
    store,
    watchService,
    context,
    mcpContext,
    modelManager,
    ownerLock,
    stopFindings,
    stopCapsules,
    closeEvents,
    disposeContext,
    closeSurface,
    onDeadline,
  } = resources;
  let deadlineReached = false;
  const drainDeadline =
    performance.now() +
    shutdownDuration(options.shutdownDeadlineMs, SHUTDOWN_DRAIN_MS);
  const abortDeadline =
    drainDeadline +
    shutdownDuration(options.shutdownAbortSettleMs, SHUTDOWN_ABORT_MS);
  const exitDeadline = abortDeadline + SHUTDOWN_EXIT_MS;
  let unfinishedJobs: Promise<void> = Promise.resolve();
  let writeFailure: unknown;
  store.beginShutdown?.(abortDeadline);
  const observe = (operation: () => unknown): Promise<void> =>
    Promise.resolve()
      .then(operation)
      .then(
        () => {},
        (error: unknown) => console.error("Resident cleanup failed:", error)
      );
  stopFindings();
  const schedulerDrain = observe(() =>
    scheduler.stop ? scheduler.stop() : scheduler.dispose()
  );
  const work = Promise.all([
    observe(() => closeSurface?.()),
    admission.drain(),
    backgroundWork.drain(),
    jobManager.shutdown(),
    schedulerDrain,
    observe(() => stopCapsules()),
    observe(() => watchService.dispose()),
    observe(() => closeEvents()),
  ]);
  if (!(await settlesBy(work, drainDeadline))) {
    deadlineReached = true;
    onDeadline();
    admission.cancel();
    backgroundWork.cancel();
    jobManager.cancel();
    const canceledScheduler = observe(() => scheduler.dispose());
    if (
      !(await settlesBy(Promise.all([work, canceledScheduler]), abortDeadline))
    ) {
      // Revoke/rollback suspended parent writers before closing their DB.
      // The ordinary store API also fences any late noncooperative callback.
      try {
        store.fenceForShutdown?.();
        // Calling close synchronously closes cached raw handles before
        // any late callback can resume in the native-exit wait.
        const closing = store.close();
        unfinishedJobs = jobManager.failUnfinished();
        if (!(await settlesBy(closing, exitDeadline)))
          throw new Error("Store close exceeded shutdown deadline");
      } catch (error) {
        writeFailure = error;
      }
    }
  }
  // Reach the single native owner directly; port disposal may itself wait
  // for that owner. Never let such a wait hide the forced-exit deadline.
  const nativeOptions = {
    deadline: exitDeadline,
    force: deadlineReached,
  };
  const native = Promise.all([
    context.llm?.dispose(nativeOptions),
    mcpContext.disposeModels?.(nativeOptions),
  ]);
  let nativeFailure: unknown;
  try {
    if (!(await settlesBy(native, exitDeadline)))
      throw new Error(
        "Native shutdown did not settle before owned-child exit deadline"
      );
  } catch (error) {
    nativeFailure = error;
    console.error("Resident native shutdown failed:", error);
  }
  const cleanup = Promise.all([
    unfinishedJobs,
    observe(() => disposeContext(context)),
    observe(() => modelManager.disposeAll()),
  ]);
  if (!(await settlesBy(cleanup, exitDeadline)))
    console.error("Resident resource cleanup exceeded shutdown deadline");
  // close performs synchronous rollback/revocation before disconnecting.
  if (writeFailure) throw writeFailure;
  if (!(await settlesBy(store.close(), exitDeadline)))
    throw new Error("Store close exceeded shutdown deadline");
  if (!(await settlesBy(ownerLock.release(), exitDeadline)))
    throw new Error("Resident owner lock release exceeded shutdown deadline");
  if (nativeFailure) throw nativeFailure;
}
