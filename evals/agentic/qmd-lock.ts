import { join } from "node:path"; // node:path: Bun has no path construction API.

import { AgenticHarnessError } from "./adapter";
import { assertSha256, canonicalFingerprint } from "./canonical";
import { parseStrictHarnessJson } from "./strict-json";

export const QMD_LOCK_SCHEMA_VERSION = "1.0" as const;
export const QMD_LOCK_FILE_SHA256 =
  "8089d441aa2cead938be2e494ad47b93a34b554ecdfaae3d5b9a5d3759aad72f";
export const QMD_TOOL_NAMES = ["query", "get", "multi_get", "status"] as const;
export type QmdToolName = (typeof QMD_TOOL_NAMES)[number];
export const QMD_MODEL_ROLES = ["embed", "rerank", "generate"] as const;
export type QmdModelRole = (typeof QMD_MODEL_ROLES)[number];

export interface QmdLockedModel {
  uri: string;
  file: string;
  cacheFile: string;
  sha256: string;
  bytes: number;
}

export interface QmdLock {
  schemaVersion: typeof QMD_LOCK_SCHEMA_VERSION;
  repository: { url: string; commit: string; tree: string };
  package: {
    name: string;
    version: string;
    packageJsonSha256: string;
    bunLockSha256: string;
  };
  entrypoint: { path: string; sha256: string };
  tools: Record<
    QmdToolName,
    { inputSchemaSha256: string; contractSha256: string }
  > & { inputSchemasSha256: string; contractsSha256: string };
  models: Record<QmdModelRole, QmdLockedModel>;
}

export interface QmdLockFile {
  lock: QmdLock;
  fileSha256: string;
}

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new AgenticHarnessError(
      "qmd_lock_invalid",
      `${label} fields differ from the closed qmd lock contract`
    );
  }
};

const objectValue = (
  value: unknown,
  label: string
): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgenticHarnessError(
      "qmd_lock_invalid",
      `${label} must be an object`
    );
  }
  return value as Record<string, unknown>;
};

const stringValue = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /^(todo|tbd|placeholder|unknown)$/i.test(value.trim())
  ) {
    throw new AgenticHarnessError(
      "qmd_lock_invalid",
      `${label} must be a concrete non-placeholder string`
    );
  }
  return value;
};

const lockedHash = (value: unknown, label: string): string => {
  const hash = stringValue(value, label);
  try {
    assertSha256(hash, label);
  } catch (cause) {
    throw new AgenticHarnessError(
      "qmd_lock_invalid",
      `${label} is not SHA-256`,
      {
        cause,
      }
    );
  }
  return hash;
};

const lockedGitObject = (value: unknown, label: string): string => {
  const object = stringValue(value, label);
  if (!/^[0-9a-f]{40}$/.test(object)) {
    throw new AgenticHarnessError(
      "qmd_lock_invalid",
      `${label} must be a full 40-character git object`
    );
  }
  return object;
};

export const validateQmdLock = (value: unknown): QmdLock => {
  const root = objectValue(value, "qmd lock");
  exactKeys(
    root,
    ["schemaVersion", "repository", "package", "entrypoint", "tools", "models"],
    "qmd lock"
  );
  if (root.schemaVersion !== QMD_LOCK_SCHEMA_VERSION) {
    throw new AgenticHarnessError(
      "qmd_lock_invalid",
      "Unsupported qmd lock schema version"
    );
  }

  const repository = objectValue(root.repository, "repository");
  exactKeys(repository, ["url", "commit", "tree"], "repository");
  const package_ = objectValue(root.package, "package");
  exactKeys(
    package_,
    ["name", "version", "packageJsonSha256", "bunLockSha256"],
    "package"
  );
  const entrypoint = objectValue(root.entrypoint, "entrypoint");
  exactKeys(entrypoint, ["path", "sha256"], "entrypoint");
  const tools = objectValue(root.tools, "tools");
  exactKeys(
    tools,
    [...QMD_TOOL_NAMES, "inputSchemasSha256", "contractsSha256"],
    "tools"
  );
  const models = objectValue(root.models, "models");
  exactKeys(models, QMD_MODEL_ROLES, "models");

  const parsedToolEntries = Object.fromEntries(
    QMD_TOOL_NAMES.map((name) => {
      const tool = objectValue(tools[name], `tools.${name}`);
      exactKeys(tool, ["inputSchemaSha256", "contractSha256"], `tools.${name}`);
      return [
        name,
        {
          inputSchemaSha256: lockedHash(
            tool.inputSchemaSha256,
            `${name} input schema hash`
          ),
          contractSha256: lockedHash(
            tool.contractSha256,
            `${name} contract hash`
          ),
        },
      ];
    })
  ) as Record<
    QmdToolName,
    { inputSchemaSha256: string; contractSha256: string }
  >;
  const parsedTools: QmdLock["tools"] = {
    query: parsedToolEntries.query,
    get: parsedToolEntries.get,
    multi_get: parsedToolEntries.multi_get,
    status: parsedToolEntries.status,
    inputSchemasSha256: lockedHash(
      tools.inputSchemasSha256,
      "aggregate input schema hash"
    ),
    contractsSha256: lockedHash(
      tools.contractsSha256,
      "aggregate contract hash"
    ),
  };

  const parsedModels = Object.fromEntries(
    QMD_MODEL_ROLES.map((role) => {
      const model = objectValue(models[role], `models.${role}`);
      exactKeys(
        model,
        ["uri", "file", "cacheFile", "sha256", "bytes"],
        `models.${role}`
      );
      if (!Number.isSafeInteger(model.bytes) || (model.bytes as number) <= 0) {
        throw new AgenticHarnessError(
          "qmd_lock_invalid",
          `models.${role}.bytes must be a positive safe integer`
        );
      }
      const file = stringValue(model.file, `models.${role}.file`);
      const cacheFile = stringValue(
        model.cacheFile,
        `models.${role}.cacheFile`
      );
      if (
        [file, cacheFile].some(
          (name) =>
            name.includes("/") || name.includes("\\") || name.includes("..")
        )
      ) {
        throw new AgenticHarnessError(
          "qmd_lock_invalid",
          `models.${role}.file must be one unambiguous cache filename`
        );
      }
      const uri = stringValue(model.uri, `models.${role}.uri`);
      const uriMatch = /^hf:([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
      if (!uriMatch || uriMatch[3] !== file) {
        throw new AgenticHarnessError(
          "qmd_lock_invalid",
          `models.${role}.file must exactly match its Hugging Face URI filename`
        );
      }
      const expectedCacheFile = `hf_${uriMatch[1]}_${file}`;
      if (cacheFile !== expectedCacheFile) {
        throw new AgenticHarnessError(
          "qmd_lock_invalid",
          `models.${role}.cacheFile must match qmd's native Hugging Face cache filename`
        );
      }
      return [
        role,
        {
          uri,
          file,
          cacheFile,
          sha256: lockedHash(model.sha256, `models.${role}.sha256`),
          bytes: model.bytes as number,
        },
      ];
    })
  ) as Record<QmdModelRole, QmdLockedModel>;
  if (
    new Set(QMD_MODEL_ROLES.map((role) => parsedModels[role].cacheFile))
      .size !== QMD_MODEL_ROLES.length
  ) {
    throw new AgenticHarnessError(
      "qmd_lock_invalid",
      "qmd model cache filenames must be unique"
    );
  }

  const path = stringValue(entrypoint.path, "entrypoint.path");
  if (path.startsWith("/") || path.includes("..")) {
    throw new AgenticHarnessError(
      "qmd_lock_invalid",
      "qmd entrypoint must be repository-relative without traversal"
    );
  }
  return {
    schemaVersion: QMD_LOCK_SCHEMA_VERSION,
    repository: {
      url: stringValue(repository.url, "repository.url"),
      commit: lockedGitObject(repository.commit, "repository.commit"),
      tree: lockedGitObject(repository.tree, "repository.tree"),
    },
    package: {
      name: stringValue(package_.name, "package.name"),
      version: stringValue(package_.version, "package.version"),
      packageJsonSha256: lockedHash(
        package_.packageJsonSha256,
        "package.json hash"
      ),
      bunLockSha256: lockedHash(package_.bunLockSha256, "bun.lock hash"),
    },
    entrypoint: {
      path,
      sha256: lockedHash(entrypoint.sha256, "entrypoint hash"),
    },
    tools: parsedTools,
    models: parsedModels,
  };
};

export const QMD_LOCK_PATH = join(
  import.meta.dir,
  "../fixtures/agentic-retrieval/qmd.lock.json"
);

export const loadQmdLockFile = async (
  lockPath = QMD_LOCK_PATH,
  expectedFileSha256 = QMD_LOCK_FILE_SHA256
): Promise<QmdLockFile> => {
  const file = Bun.file(lockPath);
  if (!(await file.exists())) {
    throw new AgenticHarnessError(
      "qmd_lock_missing",
      `qmd lock is missing: ${lockPath}`
    );
  }
  const raw = await file.text();
  const lock = validateQmdLock(parseStrictHarnessJson(raw, "qmd lock"));
  const fileSha256 = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
  if (fileSha256 !== expectedFileSha256) {
    throw new AgenticHarnessError(
      "qmd_lock_identity_mismatch",
      `qmd lock file SHA-256 mismatch: expected ${expectedFileSha256}, got ${fileSha256}`
    );
  }
  return { lock, fileSha256 };
};

export const loadQmdLock = async (
  lockPath = QMD_LOCK_PATH,
  expectedFileSha256 = QMD_LOCK_FILE_SHA256
): Promise<QmdLock> =>
  (await loadQmdLockFile(lockPath, expectedFileSha256)).lock;

export const fingerprintQmdLock = (lock: QmdLock): string =>
  canonicalFingerprint(lock);
