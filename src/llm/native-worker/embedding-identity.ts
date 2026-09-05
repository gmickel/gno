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
