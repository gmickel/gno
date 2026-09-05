import type { LlamaOptions } from "node-llama-cpp";

// Bun has no platform API.
import { platform } from "node:os";
export type LlamaGpuMode = "auto" | "metal" | "vulkan" | "cuda" | false;
export type LlamaBuildMode = "never" | "autoAttempt";

export type LlamaInitOptions = LlamaOptions & {
  build: LlamaBuildMode;
  gpu: LlamaGpuMode;
};

let invalidGpuModeWarned = false;
let invalidBuildModeWarned = false;

const DEFAULT_BACKEND_INIT_TIMEOUT_MS = 30_000;

export function resolveLlamaGpuMode(
  env: NodeJS.ProcessEnv = process.env
): LlamaGpuMode {
  const raw = (env.GNO_LLAMA_GPU ?? env.NODE_LLAMA_CPP_GPU ?? "auto")
    .trim()
    .toLowerCase();
  if (!raw || raw === "auto") {
    return "auto";
  }
  if (raw === "metal" || raw === "vulkan" || raw === "cuda") {
    return raw;
  }
  if (
    raw === "false" ||
    raw === "off" ||
    raw === "none" ||
    raw === "disable" ||
    raw === "disabled" ||
    raw === "0"
  ) {
    return false;
  }
  if (!invalidGpuModeWarned) {
    invalidGpuModeWarned = true;
    console.warn(
      `[llama] Invalid GNO_LLAMA_GPU/NODE_LLAMA_CPP_GPU value "${raw}", using auto`
    );
  }
  return "auto";
}

export function resolveLlamaBuildMode(
  env: NodeJS.ProcessEnv = process.env
): LlamaBuildMode {
  const raw = (env.GNO_LLAMA_BUILD ?? "never").trim().toLowerCase();
  if (
    !raw ||
    raw === "never" ||
    raw === "prebuilt" ||
    raw === "prebuilt-only"
  ) {
    return "never";
  }
  if (
    raw === "autoattempt" ||
    raw === "auto-attempt" ||
    raw === "source" ||
    raw === "build"
  ) {
    return "autoAttempt";
  }
  if (!invalidBuildModeWarned) {
    invalidBuildModeWarned = true;
    console.warn(`[llama] Invalid GNO_LLAMA_BUILD value "${raw}", using never`);
  }
  return "never";
}

export function resolveLlamaBackendInitTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.GNO_LLAMA_INIT_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_BACKEND_INIT_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_BACKEND_INIT_TIMEOUT_MS;
}

export function shouldRetryLlamaWithCpu(
  gpu: LlamaGpuMode,
  platformName = platform()
): boolean {
  if (gpu === false) {
    return false;
  }
  return gpu !== "auto" || platformName === "win32";
}

// ModelManager
