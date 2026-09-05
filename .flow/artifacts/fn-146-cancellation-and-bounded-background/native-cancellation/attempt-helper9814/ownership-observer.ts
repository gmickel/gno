/** Scratch QA only. Reads private owner state; never changes runtime methods. */
type SettlementView = { ownsNative?: boolean; phase?: string };
type PendingView = {
  request?: { requestId?: number; op?: string; generation?: number };
  settlement?: SettlementView;
};
type ClientView = {
  currentGeneration?: number;
  processId?: number;
  owner?: {
    busy?: boolean;
    retiring?: boolean;
    quarantined?: boolean;
    waiters?: Set<unknown>;
    pending?: PendingView[];
  };
};

export function observeOwnership(client: unknown) {
  const view = client as ClientView;
  return {
    atMonotonicMs: performance.now(),
    pid: view.processId ?? null,
    generation: view.currentGeneration ?? null,
    ownerPresent: Boolean(view.owner),
    busy: view.owner?.busy ?? false,
    retiring: view.owner?.retiring ?? false,
    quarantined: view.owner?.quarantined ?? false,
    externalWaiters: view.owner?.waiters?.size ?? 0,
    pending: (view.owner?.pending ?? []).map((pending) => ({
      requestId: pending.request?.requestId ?? null,
      op: pending.request?.op ?? null,
      generation: pending.request?.generation ?? null,
      ownsNative: pending.settlement?.ownsNative ?? null,
      phase: pending.settlement?.phase ?? null,
    })),
  };
}

/** Completion never equates public delivery with native settlement. */
export async function observeCaller<T>(
  operation: Promise<T>,
  client: unknown,
  emit: (event: unknown) => void
): Promise<T> {
  emit({ event: "caller-offered", ownership: observeOwnership(client) });
  try {
    const result = await operation;
    emit({ event: "caller-settled", result, ownership: observeOwnership(client) });
    return result;
  } catch (error) {
    emit({
      event: "caller-threw",
      error: String(error),
      ownership: observeOwnership(client),
    });
    throw error;
  }
}
