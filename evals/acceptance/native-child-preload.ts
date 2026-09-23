/** Loaded ONLY in the actual selected-source native worker, never the public parent. */
// Bun has no synchronous filesystem API for termination-safe private evidence.
import {
  readFileSync,
  writeFileSync,
  renameSync,
  realpathSync,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
} from "node:fs";
import { dirname, join } from "node:path"; // Bun has no path helpers.

import type { ChildIdentity, ChildReceipt } from "./child-receipt";
import type { AcceptanceManifest } from "./manifest";

import { childIdentitySchema } from "./child-receipt";
import { privateCapturePath } from "./windows-observation";

/** Read metadata and bytes through one handle; reject path replacement around
 * the platform ACL check rather than reopening a checked filename. */
export function readChildBootstrap(path: string): string {
  const descriptor = openSync(
    path,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
  );
  try {
    const metadata = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (
      !metadata.isFile() ||
      current.isSymbolicLink() ||
      metadata.dev !== current.dev ||
      metadata.ino !== current.ino ||
      realpathSync(path) !== path ||
      (process.platform !== "win32" && (metadata.mode & 0o077n) !== 0n)
    )
      throw new Error("Private child capture bootstrap required");
    privateCapturePath(path);
    const checked = lstatSync(path, { bigint: true });
    if (
      checked.dev !== metadata.dev ||
      checked.ino !== metadata.ino ||
      checked.isSymbolicLink()
    )
      throw new Error("Child capture bootstrap replaced during privacy check");
    const text = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (
      namedAfter.dev !== metadata.dev ||
      namedAfter.ino !== metadata.ino ||
      namedAfter.isSymbolicLink()
    )
      throw new Error("Child capture bootstrap replaced during read");
    if (
      after.size !== metadata.size ||
      after.mtimeNs !== metadata.mtimeNs ||
      after.ctimeNs !== metadata.ctimeNs
    )
      throw new Error("Child capture bootstrap changed during read");
    return text;
  } finally {
    closeSync(descriptor);
  }
}

async function installForSelectedEntry(): Promise<void> {
  const expectedEntry = realpathSync(
    new URL("../../src/llm/native-worker/entry.ts", import.meta.url)
  );
  let actualEntry: string;
  try {
    actualEntry = realpathSync(process.argv[1] ?? "");
  } catch {
    return;
  }
  // Legitimate native binding probes can inherit preloads. Never interpret their
  // argv as worker configuration and never import native capture into them.
  if (actualEntry !== expectedEntry) return;
  const path = process.env.GNO_ACCEPTANCE_CHILD_BOOTSTRAP;
  if (!path) throw new Error("Private child capture bootstrap required");
  const bootstrap = JSON.parse(readChildBootstrap(path)) as {
    identity: Omit<ChildIdentity, "pid">;
    models: AcceptanceManifest["models"];
  };
  // A worker's child_process.fork inherits execArgv. Do not preload QA in the
  // binding tester (or other descendants); keep every other execArgv unchanged.
  const ownPreload = realpathSync(import.meta.path);
  for (let index = process.execArgv.length - 1; index >= 0; index--) {
    if (
      process.execArgv[index] === "--preload" &&
      process.execArgv[index + 1] === ownPreload
    )
      process.execArgv.splice(index, 2);
    else if (process.execArgv[index] === `--preload=${ownPreload}`)
      process.execArgv.splice(index, 1);
  }
  const { NativeRuntimeConfigSchema } =
    await import("../../src/llm/native-worker/runtime-config");
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
  const { NativeDispatcher } =
    await import("../../src/llm/native-worker/dispatcher");
  const { installNativeCapture } = await import("./native-capture");
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
  const session = installNativeCapture(
    identity.runId,
    bootstrap.models,
    publish
  );
  const execute = NativeDispatcher.prototype.execute;
  NativeDispatcher.prototype.execute = async function (...args) {
    const [request] = args;
    if (current) throw new Error("Concurrent native capture unsupported");
    session.capture.modelInputs = [];
    session.capture.modelOutputs = [];
    session.capture.errors = [];
    session.capture.contextEvents = [];
    current = { identity, request, complete: false, capture: session.capture };
    publish();
    try {
      const result = await execute.apply(this, args);
      if (!result.response.result.ok) {
        session.capture.errors.push(result.response.result.error.message);
        const cause = result.response.result.error.cause;
        if (
          typeof cause === "object" &&
          cause !== null &&
          "message" in cause &&
          typeof cause.message === "string"
        )
          session.capture.errors.push(cause.message);
      }
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
}
await installForSelectedEntry();
