// node:fs/promises: cache directory and atomic replacement have no Bun-native equivalent.
import { mkdir, rename, rm } from "node:fs/promises";
// node:os: homedir has no Bun equivalent.
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MODEL_REVISION = "0f741b5a6585bd53aeb15cd1372c56f2a0f65e12";
const MODEL_FILENAME = "embeddinggemma-300M-Q8_0.gguf";
const MODEL_SHA256 =
  "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63";
const MODEL_DOWNLOAD_TIMEOUT_MS = 300_000;
const MODEL_URL = `https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/${MODEL_REVISION}/${MODEL_FILENAME}`;
const CI_MODEL_PATH = join(
  homedir(),
  ".cache",
  "gno",
  "package-smoke",
  MODEL_FILENAME
);

async function hasGgufMagic(path: string): Promise<boolean> {
  const file = Bun.file(path);
  if (!(await file.exists())) return false;
  const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return (
    magic[0] === 0x47 &&
    magic[1] === 0x47 &&
    magic[2] === 0x55 &&
    magic[3] === 0x46
  );
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(path).stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return hasher.digest("hex");
    if (value) hasher.update(value);
  }
}

export async function provisionPackageSmokeEmbeddingModel(): Promise<string> {
  if (
    (await hasGgufMagic(CI_MODEL_PATH)) &&
    (await sha256(CI_MODEL_PATH)) === MODEL_SHA256
  ) {
    return CI_MODEL_PATH;
  }

  await mkdir(dirname(CI_MODEL_PATH), { recursive: true });
  const temporaryPath = `${CI_MODEL_PATH}.${process.pid}.download`;
  await rm(temporaryPath, { force: true });
  console.log(`Provisioning pinned package-smoke model: ${MODEL_REVISION}`);
  const writer = Bun.file(temporaryPath).writer();
  try {
    const response = await fetch(MODEL_URL, {
      signal: AbortSignal.timeout(MODEL_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    for await (const chunk of response.body) await writer.write(chunk);
    await writer.end();
  } catch (error) {
    await writer.end();
    await rm(temporaryPath, { force: true });
    throw new Error(
      `Failed to provision package-smoke embedding model within ${MODEL_DOWNLOAD_TIMEOUT_MS}ms: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (
    !(await hasGgufMagic(temporaryPath)) ||
    (await sha256(temporaryPath)) !== MODEL_SHA256
  ) {
    await rm(temporaryPath, { force: true });
    throw new Error(
      "Provisioned package-smoke embedding model failed pinned SHA-256 verification"
    );
  }
  await rename(temporaryPath, CI_MODEL_PATH);
  return CI_MODEL_PATH;
}

export async function resolvePackageSmokeEmbeddingModel(): Promise<
  string | undefined
> {
  const candidates = [
    process.env.GNO_PACKAGE_SMOKE_EMBED_MODEL,
    CI_MODEL_PATH,
    join(
      homedir(),
      ".cache",
      "qmd",
      "models",
      "hf_ggml-org_embeddinggemma-300M-Q8_0.gguf"
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (await hasGgufMagic(candidate)) return resolve(candidate);
  }
  if (process.env.CI === "true") {
    throw new Error(
      "CI package smoke requires a provisioned embedding model; run `bun scripts/package-smoke-model.ts` first"
    );
  }
  return undefined;
}

if (import.meta.main) {
  const path = await provisionPackageSmokeEmbeddingModel();
  console.log(`Pinned package-smoke model ready: ${path}`);
}
