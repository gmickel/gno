// node:fs/promises: file metadata inspection has no Bun equivalent.
import { stat } from "node:fs/promises";
// node:path: path construction has no Bun equivalent.
import { join } from "node:path";

import { getModelsCachePath } from "../../../src/app/constants";
import { AgenticHarnessError } from "../adapter";
import { canonicalFingerprint } from "../canonical";
import { parseStrictHarnessJson } from "../strict-json";

export const GNO_MODEL_DIR_ENV = "GNO_AGENTIC_GNO_MODEL_DIR";
export const GNO_MODEL_LOCK_FINGERPRINT =
  "3536b4f001c3ebd6741e68005a56defbdd8e2afa03d25cd47e24be77128bcf27";

const MODEL_LOCK_PATH = join(
  import.meta.dir,
  "../../fixtures/agentic-retrieval/gno-models.lock.json"
);

export type GnoModelRole = "embed" | "rerank" | "expand" | "gen";

interface GnoModelLockEntry {
  role: GnoModelRole;
  uri: string;
  cacheFile: string;
  sha256: string;
  sizeBytes: number;
}

interface GnoModelLock {
  schemaVersion: "1.0";
  models: GnoModelLockEntry[];
}

export interface GnoLockedModel extends GnoModelLockEntry {
  path: string;
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason;
};

const hashFile = async (
  path: string,
  signal?: AbortSignal
): Promise<string> => {
  throwIfAborted(signal);
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(path).stream().getReader();
  try {
    while (true) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value) hasher.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return hasher.digest("hex");
};

export const validateGnoModelLock = (value: unknown): GnoModelLock => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgenticHarnessError(
      "gno_model_lock_invalid",
      "GNO model lock must be an object"
    );
  }
  const lock = value as Partial<GnoModelLock>;
  if (lock.schemaVersion !== "1.0" || !Array.isArray(lock.models)) {
    throw new AgenticHarnessError(
      "gno_model_lock_invalid",
      "GNO model lock version or model list is invalid"
    );
  }
  const roles = new Set<GnoModelRole>();
  for (const model of lock.models) {
    if (
      !model ||
      typeof model !== "object" ||
      !["embed", "rerank", "expand", "gen"].includes(model.role) ||
      roles.has(model.role) ||
      typeof model.uri !== "string" ||
      typeof model.cacheFile !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model.cacheFile) ||
      model.cacheFile.includes("..") ||
      !/^[a-f0-9]{64}$/.test(model.sha256) ||
      !Number.isSafeInteger(model.sizeBytes) ||
      model.sizeBytes <= 0
    ) {
      throw new AgenticHarnessError(
        "gno_model_lock_invalid",
        "GNO model lock contains an invalid or duplicate entry"
      );
    }
    roles.add(model.role);
  }
  if (roles.size !== 4) {
    throw new AgenticHarnessError(
      "gno_model_lock_invalid",
      "GNO model lock must pin all four product model roles"
    );
  }
  if (canonicalFingerprint(value) !== GNO_MODEL_LOCK_FINGERPRINT) {
    throw new AgenticHarnessError(
      "gno_model_lock_identity_mismatch",
      "GNO model lock differs from the exact benchmark model identities"
    );
  }
  return lock as GnoModelLock;
};

export const loadAndVerifyGnoModelLock = async (
  modelDir = process.env[GNO_MODEL_DIR_ENV] ?? getModelsCachePath(),
  signal?: AbortSignal
): Promise<Readonly<Record<GnoModelRole, GnoLockedModel>>> => {
  throwIfAborted(signal);
  const raw = await Bun.file(MODEL_LOCK_PATH).text();
  const lock = validateGnoModelLock(
    parseStrictHarnessJson(raw, "GNO model lock")
  );
  const resolved = {} as Record<GnoModelRole, GnoLockedModel>;
  for (const entry of lock.models) {
    throwIfAborted(signal);
    const path = join(modelDir, entry.cacheFile);
    let fileStats;
    try {
      fileStats = await stat(path);
    } catch (cause) {
      throw new AgenticHarnessError(
        "gno_model_not_cached",
        `Locked GNO ${entry.role} model is unavailable; set ${GNO_MODEL_DIR_ENV} to the exact cache directory`,
        { cause }
      );
    }
    if (
      fileStats.size !== entry.sizeBytes ||
      (await hashFile(path, signal)) !== entry.sha256
    ) {
      throw new AgenticHarnessError(
        "gno_model_checksum_mismatch",
        `Locked GNO ${entry.role} model bytes do not match the benchmark lock`
      );
    }
    resolved[entry.role] = Object.freeze({ ...entry, path });
  }
  return Object.freeze(resolved);
};
