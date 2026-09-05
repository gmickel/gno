/** Transparent JS transition receipts; never substitute timer samples for dispatch evidence. */
export function installTransitionObserver(prototype: object, emit: (row: unknown) => void, failed: (error: unknown) => void) {
  const restores: (() => void)[] = [];
  const snapshot = (owner: any) => ({
    generation: owner?.generation ?? null, busy: owner?.busy ?? null,
    foregroundCompletions: owner?.foregroundCompletions ?? null,
    pending: (owner?.pending ?? []).map((item: any) => ({
      requestId: item.request?.requestId, op: item.request?.op,
      background: typeof item.background === "boolean" ? item.background : null,
      ownsNative: item.settlement?.ownsNative ?? null,
      phase: item.settlement?.phase ?? null,
      batchChunks: item.request?.op === "embedBatch" ? item.request.texts?.length ?? null : null,
      earnsForegroundCredit: item.background === false && !["init", "dispose"].includes(item.request?.op),
    })),
  });
  const publish = (row: unknown) => { try { emit(row); } catch (error) { try { failed(error); } catch {} } };
  const observedChildren = new WeakSet<object>();
  const observeAck = (owner: any) => {
    const child = owner?.child;
    if (!child || observedChildren.has(child)) return;
    const originalSend = child.send;
    child.send = function(this: unknown, ...args: any[]) {
      const ack = args[0]?.ack;
      if (Number.isInteger(ack)) publish({ kind: "native-ack-send-before", ack, owner: snapshot(owner) });
      try {
        const result = Reflect.apply(originalSend, this, args);
        if (Number.isInteger(ack)) publish({ kind: "native-ack-send-after", ack, owner: snapshot(owner) });
        return result;
      } catch (error) { if (Number.isInteger(ack)) publish({ kind: "native-ack-send-throw", ack, error: String(error), owner: snapshot(owner) }); throw error; }
    };
    observedChildren.add(child);
    restores.push(() => { child.send = originalSend; });
  };
  for (const method of ["sendNext", "receive"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
    if (!descriptor?.writable || typeof descriptor.value !== "function") throw Error(`Missing writable native owner transition: ${method}`);
    const original = descriptor.value;
    Object.defineProperty(prototype, method, { ...descriptor, value: function(this: unknown, ...args: unknown[]) {
      const owner = args[0];
      observeAck(owner);
      const message: any = method === "receive" ? args[1] : undefined;
      const receipt = { method, message: typeof message === "string" ? message : message ? { requestId: message.requestId, generation: message.generation, executionStarted: message.executionStarted, ok: message.result?.ok, control: message.control } : null };
      publish({ kind: "native-transition-before", ...receipt, owner: snapshot(owner) });
      try {
        const result = Reflect.apply(original, this, args);
        publish({ kind: "native-transition-after", ...receipt, owner: snapshot(owner) });
        return result;
      } catch (error) {
        publish({ kind: "native-transition-throw", ...receipt, owner: snapshot(owner), error: String(error) });
        throw error;
      }
    }});
    restores.push(() => Object.defineProperty(prototype, method, descriptor));
  }
  return () => { for (const restore of restores.reverse()) restore(); };
}
