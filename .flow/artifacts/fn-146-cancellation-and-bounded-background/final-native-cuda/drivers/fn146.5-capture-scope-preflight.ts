/** CPU-only regression for session scope and stdout drain; no model or native child. */
import { drainStream } from "./fn146.5-drain";
import { mkdtemp, mkdir } from "node:fs/promises"; // Bun has no directory creation API.
const root = await mkdtemp("/home/gordon/.cache/agent-tmp/fn1465-scope-preflight-");
await mkdir(`${root}/capture`, { mode: 0o700 });
const source = "/home/gordon/.cache/agent-tmp/fn1465-final-f64c41c9/package";
const { installParentCapture } = await import(`${source}/evals/acceptance/parent-capture.ts`);
const capture = await installParentCapture("cpu-scope", [], `${root}/capture`);
console.error("installed"); capture.begin("one-session"); console.error("begun");
let overlapRejected = false;
try { capture.begin("second-request"); } catch (error) { overlapRejected = String(error).includes("Overlapping native capture scope"); }
if (!overlapRejected) throw Error("Original regression no longer reproduced");
console.error("overlap"); const preload = await Bun.file(`${import.meta.dir}/fn146.5-surface-preload.ts`).text();
if ((preload.match(/capture\.begin\(/g) ?? []).length !== 1 || preload.indexOf("capture.begin(") > preload.indexOf("NativeWorkerClient.prototype.request =")) throw Error("Scope must open exactly once before request wrapper");
console.error("source-read"); capture.finish(); console.error("finished");
capture.restore(); console.error("restored");
const child = Bun.spawn([process.execPath, "--no-env-file", "-e", "process.stdout.write('exact stdout');process.stderr.write('exact stderr')"], { stdout: "pipe", stderr: "pipe" });
await Promise.all([drainStream(`${root}/stdout`, child.stdout), drainStream(`${root}/stderr`, child.stderr)]);
if (await child.exited !== 0 || await Bun.file(`${root}/stdout`).text() !== "exact stdout" || await Bun.file(`${root}/stderr`).text() !== "exact stderr") throw Error("Stream drain mismatch");
console.log(JSON.stringify({ status: "CPU_PASS", native: false, root, originalOverlapReproduced: true, oneScopeOutsideRequestWrapper: true, exactStdoutStderr: true }));
