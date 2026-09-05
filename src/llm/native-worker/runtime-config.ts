// Bun has no synchronous canonical-directory identity API for spawn environments.
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";

import type { LlmError } from "../errors";
import type { NativeResponse } from "./protocol";

import { ApprovedModelSchema, encodeNativeMessage } from "./protocol";

// Bootstrap travels in argv; controls use single IPC messages. Bound both below
// platform argv limits and far below the framed inference transport ceiling.
const CONTROL_BYTES = 16 * 1024;
function controlFits(value: unknown): boolean {
  return encodeNativeMessage(value).length <= CONTROL_BYTES;
}

export function wireError(
  error: LlmError
): Extract<NativeResponse["result"], { ok: false }>["error"] {
  const { cause, ...detail } = error;
  const parsed = z.json().safeParse(cause);
  return parsed.success ? { ...detail, cause: parsed.data } : detail;
}

/** Private launch contract. Deliberately excludes presets, stores and credentials. */
export const NativeRuntimeConfigSchema = z
  .strictObject({
    generation: z.number().int().positive(),
    models: z.array(ApprovedModelSchema),
    loadTimeout: z.number().finite().positive(),
    inferenceTimeout: z.number().finite().positive(),
    warmModelTtl: z.number().finite().nonnegative().default(300_000),
  })
  .refine(controlFits, "Native bootstrap exceeds control capacity")
  .refine(
    (config) =>
      new Set(config.models.map((model) => model.id)).size ===
      config.models.length,
    "Duplicate native model IDs"
  );
export type NativeRuntimeConfig = z.infer<typeof NativeRuntimeConfigSchema>;

export const NativeRegistrationSchema = z
  .strictObject({
    register: ApprovedModelSchema,
  })
  .refine(controlFits, "Native registration exceeds control capacity");
export const NativeAckSchema = z.strictObject({
  ack: z.number().int().positive(),
});

/** Native tuning only; never inherit auth, proxy, DB or download configuration. */
export function nativeWorkerEnvironment(): Record<string, string> {
  const env: Record<string, string> = {
    GNO_OFFLINE: "1",
    GNO_ALLOW_DOWNLOAD: "0",
    GNO_LLAMA_BUILD: "never",
  };
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TMPDIR",
    "TEMP",
    "TMP",
    "GNO_LLAMA_GPU",
    "NODE_LLAMA_CPP_GPU",
    "GNO_LLAMA_INIT_TIMEOUT_MS",
    "GNO_EMBED_CONTEXTS",
    "GNO_EMBED_THREADS",
    "GNO_EMBED_CONTEXT_SIZE",
    "CUDA_VISIBLE_DEVICES",
    "GGML_VK_VISIBLE_DEVICES",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const cudaPath = process.env.CUDA_PATH;
  if (cudaPath && isAbsolute(cudaPath)) {
    try {
      if (
        realpathSync(cudaPath) === cudaPath &&
        statSync(cudaPath).isDirectory()
      )
        env.CUDA_PATH = cudaPath;
    } catch {
      /* Unvalidated native search paths never enter the child. */
    }
  }
  return env;
}
