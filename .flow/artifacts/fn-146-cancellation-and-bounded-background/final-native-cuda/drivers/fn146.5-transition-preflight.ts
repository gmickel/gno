/** CPU-only receiver/return/error/ACK chronology contract for scratch observation. */
import { installTransitionObserver } from "./fn146.5-transition-observer";
const rows: any[] = [], failures: unknown[] = [];
const result = {}, thrown = Error("original error");
const owner: any = { generation: 1, busy: false, foregroundCompletions: 7, pending: [{ request: { requestId: 1, op: "init" }, background: false, settlement: { ownsNative: false } }, { request: { requestId: 2, op: "embedBatch", texts: ["one", "two"] }, background: true, settlement: { ownsNative: false } }] };
owner.child = { send(message: any) { if (this !== owner.child) throw Error("send receiver changed"); if (message.ack !== 1) throw thrown; return result; } };
class Owner {
  sendNext(value: any, marker: unknown) { if (this !== instance || value !== owner || marker !== result) throw Error("arguments changed"); value.busy = true; return result; }
  receive(value: any, message: unknown) { if (message === thrown) throw thrown; value.child.send({ ack: 1 }); return result; }
}
const instance = new Owner();
const original = Owner.prototype.sendNext;
const restore = installTransitionObserver(Owner.prototype, row => rows.push(row), error => failures.push(error));
if (instance.sendNext(owner, result) !== result || instance.receive(owner, result) !== result) throw Error("Return identity changed");
try { instance.receive(owner, thrown); throw Error("Original throw lost"); } catch (error) { if (error !== thrown) throw error; }
if (rows.find(row => row.kind === "native-transition-before").owner.pending[0].earnsForegroundCredit !== false) throw Error("Metadata earned foreground credit");
if (rows.find(row => row.kind === "native-transition-before").owner.pending[1].batchChunks !== 2) throw Error("Actual batch size lost");
if (rows.findIndex(row => row.kind === "native-ack-send-before") >= rows.findIndex(row => row.kind === "native-ack-send-after")) throw Error("ACK chronology inverted");
restore();
if (Owner.prototype.sendNext !== original || failures.length) throw Error("Observer restore failed");
console.log(JSON.stringify({ status: "CPU_PASS", native: false, checks: ["receiver/argument/return identity", "original error identity", "actual pending class/batch size", "init excluded from credit", "ACK before/after chronology", "restore"] }));
