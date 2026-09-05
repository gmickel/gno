// Native-free capture values and cached-file identity checks.
// Bun has no canonical path or bigint inode/change-time stat API.
import { realpath, stat } from "node:fs/promises";
import { z } from "zod";

import type { SearchResultsTraceMetadata } from "../../src/pipeline/types";
import type { DeterministicRecord } from "./records";
export interface NativeCapture {
  runId: string;
  kind: "native" | "replay";
  modelInputs: DeterministicRecord["modelInputs"];
  modelOutputs: unknown[];
  backends: string[];
  models: { id: string; sha256: string }[];
  capabilities: { capability: string; status: string; reasonCode?: string }[];
  errors: string[];
  /** Raw child attribution and context/tokenizer telemetry, never flattened for comparison. */
  nativeRequests?: unknown[];
  /** Actual pipeline result before SDK decoration drops non-enumerable metadata. */
  searchResults?: Array<{
    source: string;
    method: string;
    result: unknown;
    trace: SearchResultsTraceMetadata | null;
  }>;
  parentNative?: {
    pid: number;
    bindingLoads: string[];
    nativeModules: string[];
    mappedModels: string[] | null;
    mappingSource: string;
  };
  contextEvents?: Array<{
    modelId: string;
    method: string;
    arguments: z.infer<ReturnType<typeof z.json>>;
    result?: z.infer<ReturnType<typeof z.json>>;
  }>;
}
export const exactJson = (value: unknown): z.infer<ReturnType<typeof z.json>> =>
  z.json().parse(value);

/** Encode undefined explicitly so omitted optional arguments never disappear. */
export function captureArguments(
  args: unknown[]
): z.infer<ReturnType<typeof z.json>> {
  return exactJson(
    args.map((value) => (value === undefined ? { $undefined: true } : value))
  );
}

const verifiedFiles = new Map<string, { identity: string; sha256: string }>();
async function fileIdentity(path: string): Promise<string> {
  const metadata = await stat(path, { bigint: true });
  if (!metadata.isFile())
    throw new Error(`Cached model is not a regular file: ${path}`);
  return [
    metadata.dev,
    metadata.ino,
    metadata.size,
    metadata.mtimeNs,
    metadata.ctimeNs,
  ].join(":");
}

/** Hash once per unchanged physical file. Every use checks inode and change-time;
 * replacements/edits force a new hash, including edits during the hash read. */
export async function hashFile(path: string): Promise<string> {
  const physical = await realpath(path);
  const identity = await fileIdentity(physical);
  const previous = verifiedFiles.get(physical);
  if (previous?.identity === identity) return previous.sha256;
  const hash = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(physical).stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  if ((await fileIdentity(physical)) !== identity)
    throw new Error(`Cached model changed while hashing: ${path}`);
  const sha256 = hash.digest("hex");
  verifiedFiles.set(physical, { identity, sha256 });
  return sha256;
}

export function emptyCapture(runId: string): NativeCapture {
  return {
    runId,
    kind: "native",
    modelInputs: [],
    modelOutputs: [],
    backends: [],
    models: [],
    capabilities: [],
    errors: [],
  };
}

/** Native context factories pass own undefined fields; preserve them recursively
 * without changing the frozen port-argument comparison representation. */
export function captureContextArguments(
  args: unknown[]
): z.infer<ReturnType<typeof z.json>> {
  function encode(value: unknown, contextOptions = false): unknown {
    if (value === undefined) return { $undefined: true };
    if (Array.isArray(value)) return value.map((entry) => encode(entry));
    if (value !== null && typeof value === "object") {
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      )
        throw new Error("Unsupported native context argument object");
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          contextOptions &&
          (key === "createSignal" || key === "signal") &&
          entry instanceof AbortSignal
            ? {
                $operational: "AbortSignal",
                aborted: entry.aborted,
                reason: captureAbortReason(entry.reason),
              }
            : encode(entry),
        ])
      );
    }
    return value;
  }
  return exactJson(args.map((argument) => encode(argument, true)));
}

function captureAbortReason(reason: unknown): unknown {
  if (reason === undefined) return { $undefined: true };
  if (reason instanceof Error || reason instanceof DOMException)
    return { name: reason.name, message: reason.message };
  try {
    return exactJson(reason);
  } catch {
    return { $unsupportedReason: typeof reason };
  }
}

/** Operational controls are recorded in contextEvents, never model-input parity. */
export function captureContextModelArguments(args: unknown[]): unknown[] {
  return args.map((argument) => {
    if (
      argument === null ||
      typeof argument !== "object" ||
      (Object.getPrototypeOf(argument) !== Object.prototype &&
        Object.getPrototypeOf(argument) !== null)
    )
      return argument;
    return Object.fromEntries(
      Object.entries(argument).filter(
        ([key, value]) =>
          !(
            (key === "createSignal" || key === "signal") &&
            (value === undefined || value instanceof AbortSignal)
          )
      )
    );
  });
}
