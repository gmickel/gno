/** MIT, Copyright (c) 2023 Gilad S. PR636 simulator lifetime backport.
 * https://github.com/withcatai/node-llama-cpp/commit/3f686d75aa9cda1b20b80465883f5f7358e42880
 * Full notice in THIRD_PARTY_NOTICES.md. No native dependency files are changed.
 */
import type {
  SimulatorBackend,
  SimulatorDependencies,
  SimulatorDisposable,
  SimulatorGuard,
  SimulatorModel,
} from "./simulator-types";

// Keep the local weak finalizer helper so repeated disposal joins the same
// promise without retaining the model target.
const finalizers = new FinalizationRegistry<SimulatorDisposable>((target) => {
  try {
    void Promise.resolve(target.dispose()).catch(() => {});
  } catch {
    /* Finalizers cannot report to callers. */
  }
});
function register(target: object, disposable: SimulatorDisposable): () => void {
  const token = {};
  finalizers.register(target, disposable, token);
  return () => {
    finalizers.unregister(token);
  };
}

export class SimulatorModelHandle {
  readonly disposeGuard: SimulatorGuard;
  private readonly backendHandle: SimulatorDisposable;
  private readonly listener: SimulatorDisposable;
  private readonly unregisterBackend: () => void;
  private readonly unregisterListener: () => void;
  private disposal?: Promise<void>;

  constructor(
    llama: SimulatorBackend,
    readonly model: SimulatorModel,
    dependencies: SimulatorDependencies
  ) {
    this.disposeGuard = new dependencies.DisposeGuard([
      llama._backendDisposeGuard,
    ]);
    this.backendHandle =
      llama._backendDisposeGuard.createPreventDisposalHandle();
    this.unregisterBackend = register(model, this.backendHandle);
    const reference = new WeakRef(this);
    this.listener = llama.onDispose.createListener(() =>
      reference
        .deref()
        ?.dispose()
        .catch(() => {})
    );
    this.unregisterListener = register(model, this.listener);
  }

  dispose(): Promise<void> {
    // All eviction/session/backend callers must observe the same completion.
    this.disposal ??= this.disposeInternal();
    return this.disposal;
  }

  private async disposeInternal(): Promise<void> {
    this.unregisterBackend();
    await this.listener.dispose();
    this.unregisterListener();
    await this.disposeGuard.acquireDisposeLock();
    await this.model.dispose().catch(() => {});
    await this.backendHandle.dispose();
  }
}
