/** Loaded ONLY in the actual selected-source native worker, never the public parent. */
// Bun has no synchronous filesystem API for termination-safe private evidence.
import {
  readFileSync,
  writeFileSync,
  renameSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { dirname, join } from "node:path"; // Bun has no path helpers.

import type { ChildIdentity, ChildReceipt } from "./child-receipt";
import type { AcceptanceManifest } from "./manifest";

import { NativeDispatcher } from "../../src/llm/native-worker/dispatcher";
import { NativeRuntimeConfigSchema } from "../../src/llm/native-worker/runtime-config";
import { childIdentitySchema } from "./child-receipt";
import { installNativeCapture } from "./native-capture";

const path = process.env.GNO_ACCEPTANCE_CHILD_BOOTSTRAP;
if (
  !path ||
  realpathSync(path) !== path ||
  !lstatSync(path).isFile() ||
  (lstatSync(path).mode & 0o077) !== 0
)
  throw new Error("Private child capture bootstrap required");
const bootstrap = JSON.parse(readFileSync(path, "utf8")) as {
  identity: Omit<ChildIdentity, "pid">;
  models: AcceptanceManifest["models"];
};
const identity = childIdentitySchema.parse({
  ...bootstrap.identity,
  pid: process.pid,
});
const config = NativeRuntimeConfigSchema.parse(
  JSON.parse(process.argv[2] ?? "null")
);
if (
  identity.parentPid !== process.ppid ||
  identity.generation !== config.generation ||
  realpathSync(process.argv[1]!) !== identity.entry
)
  throw new Error("Child bootstrap execution identity mismatch");
let current: ChildReceipt | undefined;
const publish = () => {
  if (!current) return;
  const destination = join(
    dirname(path),
    `${process.pid}-${current.request.requestId}.json`
  );
  const temporary = `${destination}.partial`;
  writeFileSync(temporary, JSON.stringify(current), {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, destination);
};
const session = installNativeCapture(identity.runId, bootstrap.models, publish);
const execute = NativeDispatcher.prototype.execute;
NativeDispatcher.prototype.execute = async function (request) {
  if (current) throw new Error("Concurrent native capture unsupported");
  session.capture.modelInputs = [];
  session.capture.modelOutputs = [];
  session.capture.errors = [];
  session.capture.contextEvents = [];
  current = { identity, request, complete: false, capture: session.capture };
  publish();
  try {
    const result = await execute.call(this, request);
    if (!result.response.result.ok)
      session.capture.errors.push(result.response.result.error.message);
    if (request.op === "dispose" && result.response.result.ok) {
      const model = config.models.find((item) => item.id === request.modelId);
      if (model)
        session.capture.models = session.capture.models.filter(
          (item) => item.id !== model.modelUri
        );
    }
    current!.lifecycle = result.response.lifecycle;
    current!.complete = true;
    return result;
  } catch (error) {
    session.capture.errors.push(String(error));
    throw error;
  } finally {
    publish();
    current = undefined;
  }
};
