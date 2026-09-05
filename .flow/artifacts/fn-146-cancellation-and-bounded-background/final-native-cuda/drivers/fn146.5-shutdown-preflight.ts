/** CPU-only forwarding checks; no product, runtime, database or model creation. */
import { createShutdownObserver, forwardObservedFactory } from "./fn146.5-shutdown-observer";
const rows: any[] = [], failures: unknown[] = [];
const observer = createShutdownObserver(row => rows.push(row), error => failures.push(error));
const options = { deadline: 12345, force: true };
const sentinel = Error("original shutdown failure"), resolved = Promise.resolve("settled");
const receiver = {
  dispose(value: unknown) { if (this !== receiver || value !== options) throw Error("changed receiver/args"); return resolved; },
  close() { throw sentinel; },
  beginShutdown(value: unknown) { if (value !== options.deadline) throw Error("deadline changed"); return options; },
};
const originalDispose = receiver.dispose;
observer.observe(receiver, "OwnedFixture", ["dispose", "close", "beginShutdown"]);
if (receiver.dispose(options) !== resolved || receiver.beginShutdown(12345) !== options) throw Error("Return identity changed");
try { receiver.close(); throw Error("Expected original error"); } catch (error) { if (error !== sentinel) throw error; }
await resolved; await Promise.resolve();
const invocation = rows.find(row => row.kind === "shutdown-invocation" && row.method === "dispose");
if (invocation.args[0].deadline !== 12345 || invocation.args[0].force !== true || !rows.some(row => row.kind === "shutdown-settled" && row.id === invocation.id)) throw Error("Settlement/deadline evidence missing");
const runtime = { dispose() { return resolved; }, scheduler: { stop() { return resolved; }, dispose() { return resolved; } } };
const result = { success: true, runtime }, factoryPromise = Promise.resolve(result);
const factoryThis = {};
const factory = function(this: unknown, ...args: unknown[]) { if (this !== factoryThis || args[0] !== options) throw Error("Factory arguments/receiver changed"); return factoryPromise; };
const wrapped = forwardObservedFactory(factory, actual => { if (actual !== result || actual.runtime !== runtime) throw Error("Runtime replaced"); observer.observeRuntime(actual.runtime); }, error => failures.push(error));
if (wrapped.call(factoryThis, options) !== factoryPromise) throw Error("Factory promise replaced");
await factoryPromise; await Promise.resolve();
if (runtime.dispose() !== resolved || runtime.scheduler.stop() !== resolved) throw Error("Runtime/scheduler promise replaced");
const rejected = Promise.reject(sentinel);
const failureOwner = { fail() { return rejected; } };
observer.observe(failureOwner, "RejectedFixture", ["fail"]);
const returned = failureOwner.fail();
if (returned !== rejected) throw Error("Rejected promise identity changed");
try { await returned; throw Error("Expected original rejection"); } catch (error) { if (error !== sentinel) throw error; }
observer.restore();
if (receiver.dispose !== originalDispose || failures.length) throw Error("Observation restore/error failure");
console.log(JSON.stringify({ status: "CPU_PASS", native: false, checks: ["method receiver/argument/return/promise identity", "original throw identity", "exact numeric deadline/force", "separate invocation/settlement", "original factory receiver/args/promise/runtime identity", "scheduler writable object methods", "restore"] }));
