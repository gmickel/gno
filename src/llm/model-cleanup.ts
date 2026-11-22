/**
 * Zero-dependency shutdown hook for the lazy native ModelManager singleton.
 * Allows CLI exit cleanup to avoid importing node-llama-cpp lifecycle code
 * when no model manager was initialized during the command.
 *
 * @module src/llm/model-cleanup
 */

type ModelManagerResetFn = () => Promise<void>;

let resetFn: ModelManagerResetFn | null = null;

/** Register the active ModelManager reset callback once a manager is created. */
export function registerModelManagerReset(fn: ModelManagerResetFn): void {
  resetFn = fn;
}

/** Dispose any initialized ModelManager; no-op when models were never loaded. */
export async function resetLoadedModelManager(): Promise<void> {
  if (!resetFn) {
    return;
  }
  await resetFn();
}
