// Bun has no sync readFileSync/fd-read or inode/ctime identity API.
import { readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const FINGERPRINT_BUFFER_BYTES = 4 * 1024 * 1024;
let cachedNativePackageVersion: string | null = null;

/**
 * Lazily read node-llama-cpp's version from package.json on first use without
 * top-level await or eager node-llama-cpp module evaluation. A standalone
 * compiled executable ships no node-llama-cpp package, returning "unavailable".
 */
export function getNativePackageVersion(): string {
  if (cachedNativePackageVersion !== null) {
    return cachedNativePackageVersion;
  }
  try {
    const pkgUrl = new URL(
      "../package.json",
      import.meta.resolve("node-llama-cpp")
    );
    const parsed = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as {
      version?: unknown;
    };
    cachedNativePackageVersion =
      typeof parsed.version === "string" && parsed.version.length > 0
        ? parsed.version
        : "unavailable";
  } catch {
    cachedNativePackageVersion = "unavailable";
  }
  return cachedNativePackageVersion;
}

export async function fileIdentity(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

/** Stream the actual child-approved artifact with a reusable 4 MB buffer; never buffer a GGUF in RAM. */
export async function fingerprintModel(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  const fh = await open(path, "r");
  const buf = new Uint8Array(FINGERPRINT_BUFFER_BYTES);
  try {
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return hash.digest("hex");
}

export function fingerprintRuntime(settings: Record<string, unknown>): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        policy: "native-embedding-v1",
        bun: Bun.version,
        nativeVersion: getNativePackageVersion(),
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
        getNativePackageVersion(),
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
