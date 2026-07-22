// node:os: home directory lookup has no Bun equivalent.
import { homedir } from "node:os";
// node:path: path construction and containment checks have no Bun equivalent.
import { isAbsolute, join, relative, resolve } from "node:path";

import { AgenticHarnessError } from "./adapter";
import { sha256Bytes } from "./canonical";
import {
  fingerprintQmdLock,
  loadQmdLockFile,
  QMD_LOCK_FILE_SHA256,
  QMD_MODEL_ROLES,
  type QmdLock,
  type QmdModelRole,
} from "./qmd-lock";
import { parseStrictHarnessJson } from "./strict-json";

export interface QmdCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type QmdCommandRunner = (input: {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}) => Promise<QmdCommandResult>;

export interface QmdPreflightResult {
  lock: QmdLock;
  lockFileSha256: string;
  lockFingerprint: string;
  repoPath: string;
  entrypointPath: string;
  modelCachePath: string;
  modelPaths: Record<QmdModelRole, string>;
  repositoryFingerprint: string;
}

export interface QmdPreflightOptions {
  repoPath?: string;
  modelCachePath?: string;
  commandRunner?: QmdCommandRunner;
  signal?: AbortSignal;
}

export interface QmdPreflightDependencies {
  loadLockFile: typeof loadQmdLockFile;
}

const DEFAULT_QMD_PREFLIGHT_DEPENDENCIES: QmdPreflightDependencies = {
  loadLockFile: loadQmdLockFile,
};

export const runQmdCommand: QmdCommandRunner = async (input) => {
  const child = Bun.spawn([input.command, ...input.args], {
    cwd: input.cwd,
    env: input.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
    signal: input.signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const runGit = async (
  runner: QmdCommandRunner,
  repoPath: string,
  args: readonly string[],
  signal?: AbortSignal
): Promise<string> => {
  const result = await runner({
    command: "/usr/bin/git",
    args,
    cwd: repoPath,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new AgenticHarnessError(
      "qmd_checkout_invalid",
      `qmd git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`
    );
  }
  return result.stdout.trim();
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason;
};

export const hashQmdFile = async (
  path: string,
  signal?: AbortSignal
): Promise<string> => {
  throwIfAborted(signal);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new AgenticHarnessError(
      "qmd_file_missing",
      `Required qmd file is missing: ${path}`
    );
  }
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = file.stream().getReader();
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
    }
  } finally {
    if (signal?.aborted) await reader.cancel(signal.reason).catch(() => {});
    reader.releaseLock();
  }
  return hasher.digest("hex");
};

const normalizeRepositoryUrl = (url: string): string =>
  url
    .trim()
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
    .toLowerCase();

const requireEqual = (
  actual: string,
  expected: string,
  code: string,
  label: string
): void => {
  if (actual !== expected) {
    throw new AgenticHarnessError(
      code,
      `${label} mismatch: expected ${expected}, got ${actual || "<empty>"}`
    );
  }
};

const validatePackage = async (
  repoPath: string,
  lock: QmdLock,
  signal?: AbortSignal
): Promise<void> => {
  const packagePath = join(repoPath, "package.json");
  requireEqual(
    await hashQmdFile(packagePath, signal),
    lock.package.packageJsonSha256,
    "qmd_package_hash_mismatch",
    "qmd package.json hash"
  );
  requireEqual(
    await hashQmdFile(join(repoPath, "bun.lock"), signal),
    lock.package.bunLockSha256,
    "qmd_package_hash_mismatch",
    "qmd bun.lock hash"
  );
  const package_ = parseStrictHarnessJson(
    await Bun.file(packagePath).text(),
    "qmd package.json"
  ) as {
    name?: unknown;
    version?: unknown;
    repository?: { url?: unknown };
  };
  requireEqual(
    String(package_.name ?? ""),
    lock.package.name,
    "qmd_package_mismatch",
    "qmd package name"
  );
  requireEqual(
    String(package_.version ?? ""),
    lock.package.version,
    "qmd_package_mismatch",
    "qmd package version"
  );
  requireEqual(
    normalizeRepositoryUrl(String(package_.repository?.url ?? "")),
    normalizeRepositoryUrl(lock.repository.url),
    "qmd_repository_mismatch",
    "qmd package repository"
  );
};

const validateModelCache = async (
  modelCachePath: string,
  lock: QmdLock,
  signal?: AbortSignal
): Promise<Record<QmdModelRole, string>> => {
  const paths = {} as Record<QmdModelRole, string>;
  const failures: string[] = [];
  for (const role of QMD_MODEL_ROLES) {
    throwIfAborted(signal);
    const model = lock.models[role];
    const path = join(modelCachePath, model.cacheFile);
    const file = Bun.file(path);
    if (!(await file.exists())) {
      failures.push(`${role}: missing ${model.cacheFile}`);
      continue;
    }
    if (file.size !== model.bytes) {
      failures.push(`${role}: byte size ${file.size} != ${model.bytes}`);
      continue;
    }
    const actualHash = await hashQmdFile(path, signal);
    if (actualHash !== model.sha256) {
      failures.push(`${role}: sha256 ${actualHash} != ${model.sha256}`);
      continue;
    }
    paths[role] = path;
  }
  if (failures.length > 0) {
    throw new AgenticHarnessError(
      "qmd_model_preflight_failed",
      `Pinned qmd model cache is incomplete or stale: ${failures.join("; ")}. Run an explicit isolated qmd pull --refresh before requesting the comparator.`
    );
  }
  return paths;
};

export const preflightQmd = async (
  options: QmdPreflightOptions = {},
  dependencies: QmdPreflightDependencies = DEFAULT_QMD_PREFLIGHT_DEPENDENCIES
): Promise<QmdPreflightResult> => {
  throwIfAborted(options.signal);
  const repoInput = options.repoPath ?? process.env.QMD_REPO;
  if (!repoInput || !isAbsolute(repoInput)) {
    throw new AgenticHarnessError(
      "qmd_repo_missing",
      "QMD_REPO must name an absolute dedicated qmd checkout"
    );
  }
  const repoPath = resolve(repoInput);
  const lockFile = await dependencies.loadLockFile(
    undefined,
    QMD_LOCK_FILE_SHA256
  );
  const { lock } = lockFile;
  const runner = options.commandRunner ?? runQmdCommand;
  if (!(await Bun.file(join(repoPath, ".git", "HEAD")).exists())) {
    throw new AgenticHarnessError(
      "qmd_checkout_invalid",
      "QMD_REPO is not a git checkout"
    );
  }
  const [commit, tree, status, origin] = await Promise.all([
    runGit(runner, repoPath, ["rev-parse", "HEAD^{commit}"], options.signal),
    runGit(runner, repoPath, ["rev-parse", "HEAD^{tree}"], options.signal),
    runGit(
      runner,
      repoPath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      options.signal
    ),
    runGit(
      runner,
      repoPath,
      ["config", "--get", "remote.origin.url"],
      options.signal
    ),
  ]);
  requireEqual(
    commit,
    lock.repository.commit,
    "qmd_revision_mismatch",
    "qmd HEAD"
  );
  requireEqual(tree, lock.repository.tree, "qmd_tree_mismatch", "qmd tree");
  if (status) {
    throw new AgenticHarnessError(
      "qmd_checkout_dirty",
      `qmd checkout must be clean: ${status.split("\n")[0]}`
    );
  }
  requireEqual(
    normalizeRepositoryUrl(origin),
    normalizeRepositoryUrl(lock.repository.url),
    "qmd_repository_mismatch",
    "qmd origin"
  );
  await validatePackage(repoPath, lock, options.signal);

  const entrypointPath = resolve(repoPath, lock.entrypoint.path);
  if (relative(repoPath, entrypointPath).startsWith("..")) {
    throw new AgenticHarnessError(
      "qmd_entrypoint_invalid",
      "Locked qmd entrypoint escapes the checkout"
    );
  }
  const entrypointStats = await Bun.file(entrypointPath).stat();
  if (!entrypointStats.isFile() || (entrypointStats.mode & 0o111) === 0) {
    throw new AgenticHarnessError(
      "qmd_entrypoint_invalid",
      "Locked qmd entrypoint is not an executable regular file"
    );
  }
  requireEqual(
    await hashQmdFile(entrypointPath, options.signal),
    lock.entrypoint.sha256,
    "qmd_entrypoint_mismatch",
    "qmd entrypoint hash"
  );
  const llmSource = await Bun.file(join(repoPath, "src/llm.ts")).text();
  throwIfAborted(options.signal);
  for (const role of QMD_MODEL_ROLES) {
    if (!llmSource.includes(JSON.stringify(lock.models[role].uri))) {
      throw new AgenticHarnessError(
        "qmd_model_contract_mismatch",
        `Locked ${role} model URI is not the default at the pinned revision`
      );
    }
  }

  const configuredModelCache =
    options.modelCachePath ?? process.env.QMD_MODEL_CACHE;
  if (configuredModelCache && !isAbsolute(configuredModelCache)) {
    throw new AgenticHarnessError(
      "qmd_model_cache_invalid",
      "QMD_MODEL_CACHE must be an absolute read-only source cache path"
    );
  }
  const modelCachePath = resolve(
    configuredModelCache ??
      join(
        process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
        "qmd/models"
      )
  );
  const modelPaths = await validateModelCache(
    modelCachePath,
    lock,
    options.signal
  );
  return {
    lock,
    lockFileSha256: lockFile.fileSha256,
    lockFingerprint: fingerprintQmdLock(lock),
    repoPath,
    entrypointPath,
    modelCachePath,
    modelPaths,
    repositoryFingerprint: sha256Bytes(`${commit}\n${tree}\n${origin}\n`),
  };
};

export const assertQmdCheckoutStillClean = async (
  preflight: QmdPreflightResult,
  runner: QmdCommandRunner = runQmdCommand,
  signal?: AbortSignal
): Promise<void> => {
  const status = await runGit(
    runner,
    preflight.repoPath,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    signal
  );
  if (status) {
    throw new AgenticHarnessError(
      "qmd_checkout_mutated",
      `qmd execution mutated its checkout: ${status.split("\n")[0]}`
    );
  }
};
