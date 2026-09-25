// Bun has no inode/ctime identity API. Check replacement during hashing/loading.
import { stat } from "node:fs/promises";

const nativePackage: { version: string } = await Bun.file(
  new URL("../package.json", import.meta.resolve("node-llama-cpp"))
).json();

export async function fileIdentity(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

/** Stream the actual child-approved artifact; never buffer a GGUF in parent RAM. */
export async function fingerprintModel(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const bytes of Bun.file(path).stream()) hash.update(bytes);
  return hash.digest("hex");
}

export function fingerprintRuntime(settings: Record<string, unknown>): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        policy: "native-embedding-v1",
        bun: Bun.version,
        nativeVersion: nativePackage.version,
        platform: process.platform,
        arch: process.arch,
        ...settings,
      })
    )
    .digest("hex");
}

/** Environment that shapes the native runtime identity of an embedding. */
const RUNTIME_ENV = [
  "GNO_LLAMA_GPU",
  "NODE_LLAMA_CPP_GPU",
  "GNO_EMBED_CONTEXT_SIZE",
  "GNO_EMBED_CONTEXTS",
  "GNO_EMBED_THREADS",
] as const;

/**
 * What a process can know about its embedding runtime without loading the
 * model: status looks up the identity a caller with this key last resolved.
 */
export function runtimeCallerKey(
  model: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([
        model,
        Bun.version,
        nativePackage.version,
        process.platform,
        process.arch,
        RUNTIME_ENV.map((name) => env[name] ?? null),
      ])
    )
    .digest("hex");
}

const BACKEND_LABELS: Record<string, string> = {
  cuda: "CUDA",
  metal: "Metal",
  vulkan: "Vulkan",
};

/** Readable provenance for status output; identity stays the fingerprint. */
export function runtimeLabel(gpu: string | false): string {
  return `${gpu ? (BACKEND_LABELS[gpu] ?? gpu) : "CPU"}, Bun ${Bun.version}`;
}
