/** Observe writable methods only. Arguments, returned promises and errors retain identity. */
export function createShutdownObserver(emit: (row: unknown) => void, failed: (error: unknown) => void) {
  let sequence = 0;
  const restores: (() => void)[] = [];
  const installed = new WeakMap<object, Set<string>>();
  const safe = (value: any): unknown => {
    if (value === null || ["undefined", "number", "boolean", "string"].includes(typeof value)) return value === undefined ? { kind: "undefined" } : value;
    if (typeof value === "function") return { kind: "function", sha256: new Bun.CryptoHasher("sha256").update(Function.prototype.toString.call(value)).digest("hex") };
    if (value instanceof AbortSignal) return { kind: "AbortSignal", aborted: value.aborted };
    return { kind: "object", ...Object.fromEntries(["deadline", "force", "generation", "busy", "retiring"].filter(key => key in value).map(key => [key, value[key]])), ...(value.child?.pid ? { childPid: value.child.pid } : {}) };
  };
  const publish = (row: unknown) => { try { emit(row); } catch (error) { try { failed(error); } catch {} } };
  const observe = (target: object, label: string, methods: string[]) => {
    const names = installed.get(target) ?? new Set<string>(); installed.set(target, names);
    for (const method of methods) {
      if (names.has(method)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(target, method);
      if (!descriptor?.writable || typeof descriptor.value !== "function") throw Error(`Writable shutdown seam missing: ${label}.${method}`);
      const original = descriptor.value;
      publish({ kind: "shutdown-function-pin", label, method, sha256: new Bun.CryptoHasher("sha256").update(Function.prototype.toString.call(original)).digest("hex") });
      Object.defineProperty(target, method, { ...descriptor, value: function(this: unknown, ...args: unknown[]) {
        const id = ++sequence;
        const start = performance.now();
        publish({ kind: "shutdown-invocation", id, label, method, atMonotonicMs: start, atEpochMs: Date.now(), args: args.map(safe) });
        try {
          const result = Reflect.apply(original, this, args);
          if (result instanceof Promise) {
            // Observe on a side branch; return the exact original promise to the product.
            void result.then(
              () => publish({ kind: "shutdown-settled", id, label, method, atMonotonicMs: performance.now(), outcome: "fulfilled" }),
              (error: unknown) => publish({ kind: "shutdown-settled", id, label, method, atMonotonicMs: performance.now(), outcome: "rejected", error: String(error) })
            );
          } else publish({ kind: "shutdown-settled", id, label, method, atMonotonicMs: performance.now(), outcome: "returned", value: safe(result) });
          return result;
        } catch (error) {
          publish({ kind: "shutdown-settled", id, label, method, atMonotonicMs: performance.now(), outcome: "threw", error: String(error) });
          throw error;
        }
      }});
      names.add(method);
      restores.push(() => { Object.defineProperty(target, method, descriptor); names.delete(method); });
    }
  };
  return {
    observe,
    observeRuntime(runtime: any) { observe(runtime, "ResidentRuntime", ["dispose"]); observe(runtime.scheduler, "EmbedScheduler", ["stop", "dispose"]); },
    restore() { for (const restore of restores.reverse()) restore(); },
  };
}

/** Observe the actual result of a real factory without substituting the factory or its promise. */
export function forwardObservedFactory(original: (...args: any[]) => any, observe: (result: any) => void, failed: (error: unknown) => void) {
  return function(this: unknown, ...args: unknown[]) {
    const result = Reflect.apply(original, this, args);
    const inspect = (value: unknown) => { try { observe(value); } catch (error) { try { failed(error); } catch {} } };
    if (result instanceof Promise) void result.then(inspect, () => {});
    else inspect(result);
    return result;
  };
}
