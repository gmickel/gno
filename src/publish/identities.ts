/** Private durable publish identities, independent of the disposable index. */
// node:fs/promises — canonical paths, permissions and atomic rename have no Bun equivalents.
import {
  chmod,
  lstat,
  mkdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
// node:path — Bun has no path utilities.
import { dirname, isAbsolute, join, normalize } from "node:path";

import { getConfigPaths, toAbsolutePath } from "../config/paths";
import { acquireWriteLock, type WriteLockHandle } from "../core/file-lock";
import { PUBLISH_NOTE_ID_PATTERN } from "./artifact-validation";

const IDENTITY_LOCK_TIMEOUT_MS = 5000;
const IDENTITY_LOCK_RETRY_MS = 25;

type Registry = { version: 1; identities: Record<string, string> };

export function publishIdentityRegistryPath(configPath?: string): string {
  return join(
    configPath
      ? dirname(toAbsolutePath(configPath))
      : getConfigPaths().configDir,
    "publish-identities.json"
  );
}

function validateRegistry(value: unknown): Registry {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid registry object");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    Object.keys(record).length !== 2 ||
    !record.identities ||
    typeof record.identities !== "object" ||
    Array.isArray(record.identities)
  )
    throw new Error("Invalid registry version or identities");
  const identities = record.identities as Record<string, unknown>;
  const ids = new Set<string>();
  for (const [key, id] of Object.entries(identities)) {
    const source: unknown = JSON.parse(key);
    if (
      !Array.isArray(source) ||
      source.length !== 2 ||
      !source.every((part) => typeof part === "string" && part.length > 0) ||
      typeof id !== "string" ||
      !PUBLISH_NOTE_ID_PATTERN.test(id) ||
      ids.has(id)
    )
      throw new Error("Invalid or duplicate registry identity");
    ids.add(id);
  }
  return value as Registry;
}

async function readRegistry(path: string): Promise<Registry> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Registry must be a regular private file");
    await chmod(path, 0o600);
    return validateRegistry(await Bun.file(path).json());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, identities: {} };
    throw new Error(
      "Cannot read publish identity registry; restore a valid backup before exporting",
      { cause: error }
    );
  }
}

async function acquireIdentityLock(path: string): Promise<WriteLockHandle> {
  const deadline = performance.now() + IDENTITY_LOCK_TIMEOUT_MS;
  // Zero-wait attempts avoid blocking the JS holder on SQLite's busy timeout.
  // flock -w 0 and lockf -t 0 also mean immediate acquisition or failure.
  let lock = await acquireWriteLock(path, 0);
  while (!lock) {
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new Error("Publish identity registry is busy; retry the export");
    await Bun.sleep(Math.min(IDENTITY_LOCK_RETRY_MS, remaining));
    lock = await acquireWriteLock(path, 0);
  }
  return lock;
}

/** Allocate a batch under one OS lock; publish IDs only after the private file commits. */
export async function resolvePublishNoteIds(input: {
  collectionRoot: string;
  sourceRelPaths: string[];
  configPath?: string;
}): Promise<string[]> {
  let root: string;
  try {
    root = await realpath(toAbsolutePath(input.collectionRoot));
  } catch (cause) {
    throw new Error(
      "Collection root must exist and be accessible to resolve publish identities",
      { cause }
    );
  }
  const keys = input.sourceRelPaths.map((source) => {
    const rel = normalize(source).replaceAll("\\", "/");
    if (
      !rel ||
      rel === "." ||
      rel === ".." ||
      rel.startsWith("../") ||
      isAbsolute(rel) ||
      rel.includes("\0")
    )
      throw new Error(
        "Publish source path must be relative to its collection root"
      );
    return JSON.stringify([root, rel]);
  });
  const path = publishIdentityRegistryPath(input.configPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await acquireIdentityLock(`${path}.lock`);
  const temporaryPath = `${path}.tmp.${crypto.randomUUID()}`;
  try {
    const registry = await readRegistry(path);
    let changed = false;
    const ids = keys.map((key) => {
      const existing = registry.identities[key];
      if (existing) return existing;
      const id = crypto.randomUUID();
      registry.identities[key] = id;
      changed = true;
      return id;
    });
    if (changed) {
      await Bun.write(temporaryPath, JSON.stringify(registry), { mode: 0o600 });
      await rename(temporaryPath, path);
    }
    return ids;
  } catch (error) {
    throw new Error(
      "Publish identity registry update failed; export aborted to preserve note identity",
      { cause: error }
    );
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
    await lock.release();
  }
}
