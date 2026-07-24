// node:fs/promises provides realpath/stat; Bun has no equivalent for symlink-safe path identity and regular-file metadata.
import { realpath, stat } from "node:fs/promises";
// node:path provides cross-platform path operations; Bun has no path utilities.
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Config, ModelPreset } from "../config/types";

import { normalizeContentTypes } from "../config/content-types";
import { createDefaultConfig } from "../config/defaults";
import {
  PROJECT_PROFILE_FORCED_EXCLUDES,
  PROJECT_PROFILE_SCHEMA_VERSION,
  type ProjectProfile,
} from "../config/project-profile";
import { parseModelUri } from "../llm/cache";
import { getPreset } from "../llm/registry";
import { canonicalOperationalPath } from "./config-write-lock";
import {
  canonicalProjectProfileJson,
  compareCodeUnits,
  fingerprintProjectProfileState,
  normalizeLogicalPath,
  projectProfileIncludePattern,
  sha256,
  sortedUnique,
} from "./project-profile-canonical";
import { parseProjectProfile } from "./project-profile-parser";

export {
  canonicalProjectProfileJson,
  fingerprintProjectProfileState,
  projectProfileIncludePattern,
} from "./project-profile-canonical";
export type ProjectProfileDiagnosticCode =
  | "COLLECTION_ROOT_NOT_DIRECTORY"
  | "CONTEXT_FILE_INVALID"
  | "CONTEXT_FILE_NOT_REGULAR"
  | "CONTEXT_FILE_TOO_LARGE"
  | "CONTEXT_FILE_UNREADABLE"
  | "INVALID_PROFILE"
  | "MIGRATION_REQUIRED"
  | "MODEL_CACHE_CHECK_FAILED"
  | "MODEL_PATH_OVERLAP"
  | "MODEL_PRESET_NOT_FOUND"
  | "MODEL_PRESET_UNAVAILABLE_OFFLINE"
  | "PATH_NOT_FOUND"
  | "SYMLINK_ESCAPE"
  | "UNSAFE_PATH"
  | "UNSUPPORTED_SCHEMA_MAJOR"
  | "UNSUPPORTED_SCHEMA_MINOR";

export interface ProjectProfileDiagnostic {
  code: ProjectProfileDiagnosticCode;
  severity: "error" | "warning";
  path: string;
  message: string;
}

export interface ProjectProfileContextState {
  scopeType: "collection";
  scopeKey: string;
  text: string;
  source:
    | { kind: "inline"; sha256: string }
    | { kind: "file"; path: string; sha256: string };
}

export interface ProjectProfileDesiredState {
  schemaVersion: typeof PROJECT_PROFILE_SCHEMA_VERSION;
  collection: {
    name: string;
    root: string;
    include: string[];
    exclude: string[];
    languageHint?: string;
    modelPreset?: string;
  };
  contexts: ProjectProfileContextState[];
  contentTypes: Array<{
    id: string;
    prefixes: string[];
    preset: string;
    graphHints?: string[];
    searchBoost?: number;
    temporal?: boolean;
  }>;
  affinityDefaults: {
    enabled: boolean;
    contribution: number;
  };
  recommendedCapabilities: string[];
}

export interface ResolvedProjectProfilePaths {
  profileRoot: string;
  collectionRoot: string;
  contextFiles: Array<{
    logicalPath: string;
    absolutePath: string;
  }>;
}

export interface CompiledProjectProfile {
  profile: ProjectProfile;
  desiredState: ProjectProfileDesiredState;
  canonicalJson: string;
  fingerprint: string;
  resolvedPaths: ResolvedProjectProfilePaths;
  diagnostics: ProjectProfileDiagnostic[];
}

export type CompileProjectProfileResult =
  | { ok: true; value: CompiledProjectProfile }
  | { ok: false; diagnostics: ProjectProfileDiagnostic[] };

export interface ProjectProfileCompilerOptions {
  profileRoot: string;
  config?: Config;
  isModelAvailableOffline?: (
    modelUri: string,
    modelType: "embed" | "rerank" | "expand" | "gen"
  ) => Promise<boolean>;
}

export const PROJECT_PROFILE_CONTEXT_FILE_MAX_BYTES = 65_536;

const isContained = (parent: string, candidate: string): boolean => {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
};

const resolveContainedPath = async (
  profileRoot: string,
  logicalPath: string,
  diagnosticPath: string
): Promise<
  | {
      ok: true;
      absolutePath: string;
      metadata: Awaited<ReturnType<typeof stat>>;
    }
  | { ok: false; diagnostic: ProjectProfileDiagnostic }
> => {
  const candidate = resolve(profileRoot, normalizeLogicalPath(logicalPath));
  let absolutePath: string;
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    absolutePath = await realpath(candidate);
    metadata = await stat(absolutePath);
  } catch {
    return {
      ok: false,
      diagnostic: {
        code: "PATH_NOT_FOUND",
        severity: "error",
        path: diagnosticPath,
        message: "Referenced project path does not exist.",
      },
    };
  }
  if (!isContained(profileRoot, absolutePath)) {
    return {
      ok: false,
      diagnostic: {
        code: "SYMLINK_ESCAPE",
        severity: "error",
        path: diagnosticPath,
        message:
          "Referenced project path resolves outside the trusted profile root.",
      },
    };
  }
  return { ok: true, absolutePath, metadata };
};

const modelUris = (
  preset: ModelPreset
): Array<["embed" | "rerank" | "expand" | "gen", string]> => [
  ["embed", preset.embed],
  ["rerank", preset.rerank],
  ["expand", preset.expand ?? preset.gen],
  ["gen", preset.gen],
];

const diagnoseModelPreset = async (
  profile: ProjectProfile,
  options: ProjectProfileCompilerOptions,
  profileRoot: string
): Promise<ProjectProfileDiagnostic[]> => {
  const presetId = profile.collection.modelPreset;
  if (!presetId) return [];
  const preset = getPreset(options.config ?? createDefaultConfig(), presetId);
  if (!preset) {
    return [
      {
        code: "MODEL_PRESET_NOT_FOUND",
        severity: "error",
        path: "collection.modelPreset",
        message: `Model preset alias "${presetId}" is not configured.`,
      },
    ];
  }
  for (const [, uri] of modelUris(preset)) {
    const parsed = parseModelUri(uri);
    if (!parsed.ok || parsed.value.scheme !== "file") continue;
    const modelPath = await canonicalOperationalPath(parsed.value.file);
    if (isContained(profileRoot, modelPath)) {
      return [
        {
          code: "MODEL_PATH_OVERLAP",
          severity: "error",
          path: "collection.modelPreset",
          message:
            "The selected model preset resolves runtime model state inside the project profile root.",
        },
      ];
    }
  }
  if (!options.isModelAvailableOffline) return [];

  const unavailable: string[] = [];
  try {
    for (const [modelType, uri] of modelUris(preset)) {
      if (!(await options.isModelAvailableOffline(uri, modelType))) {
        unavailable.push(modelType);
      }
    }
  } catch {
    return [
      {
        code: "MODEL_CACHE_CHECK_FAILED",
        severity: "error",
        path: "collection.modelPreset",
        message: `Offline cache availability could not be verified for model preset alias "${presetId}".`,
      },
    ];
  }
  if (unavailable.length === 0) return [];
  return [
    {
      code: "MODEL_PRESET_UNAVAILABLE_OFFLINE",
      severity: "error",
      path: "collection.modelPreset",
      message: `Model preset alias "${presetId}" is unavailable offline for: ${unavailable.join(", ")}.`,
    },
  ];
};

export async function compileProjectProfileYaml(
  yaml: string,
  options: ProjectProfileCompilerOptions
): Promise<CompileProjectProfileResult> {
  const parsed = parseProjectProfile(yaml);
  if ("ok" in parsed) return parsed;
  const profile = parsed;
  const diagnostics: ProjectProfileDiagnostic[] = [];

  let profileRoot: string;
  try {
    profileRoot = await realpath(options.profileRoot);
  } catch {
    return {
      ok: false,
      diagnostics: [
        {
          code: "PATH_NOT_FOUND",
          severity: "error",
          path: "profileRoot",
          message: "Trusted project profile root does not exist.",
        },
      ],
    };
  }

  const collectionRoot = await resolveContainedPath(
    profileRoot,
    profile.collection.root,
    "collection.root"
  );
  if (!collectionRoot.ok) diagnostics.push(collectionRoot.diagnostic);
  else if (!collectionRoot.metadata.isDirectory()) {
    diagnostics.push({
      code: "COLLECTION_ROOT_NOT_DIRECTORY",
      severity: "error",
      path: "collection.root",
      message: "The collection root must resolve to a directory.",
    });
  }

  const contexts: ProjectProfileContextState[] = [];
  const contextFiles: ResolvedProjectProfilePaths["contextFiles"] = [];
  for (const [index, context] of profile.contexts.entries()) {
    if ("text" in context) {
      contexts.push({
        scopeType: "collection",
        scopeKey: `${profile.collection.name}:`,
        text: context.text,
        source: { kind: "inline", sha256: sha256(context.text) },
      });
      continue;
    }

    const resolved = await resolveContainedPath(
      profileRoot,
      context.file,
      `contexts[${index}].file`
    );
    if (!resolved.ok) {
      diagnostics.push(resolved.diagnostic);
      continue;
    }
    if (!resolved.metadata.isFile()) {
      diagnostics.push({
        code: "CONTEXT_FILE_NOT_REGULAR",
        severity: "error",
        path: `contexts[${index}].file`,
        message: "Context input must resolve to a regular file.",
      });
      continue;
    }
    if (resolved.metadata.size > PROJECT_PROFILE_CONTEXT_FILE_MAX_BYTES) {
      diagnostics.push({
        code: "CONTEXT_FILE_TOO_LARGE",
        severity: "error",
        path: `contexts[${index}].file`,
        message: `Context file exceeds ${PROJECT_PROFILE_CONTEXT_FILE_MAX_BYTES} bytes.`,
      });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(
        await Bun.file(resolved.absolutePath)
          .slice(0, PROJECT_PROFILE_CONTEXT_FILE_MAX_BYTES + 1)
          .arrayBuffer()
      );
    } catch {
      diagnostics.push({
        code: "CONTEXT_FILE_UNREADABLE",
        severity: "error",
        path: `contexts[${index}].file`,
        message: "Context file could not be read.",
      });
      continue;
    }
    if (bytes.byteLength > PROJECT_PROFILE_CONTEXT_FILE_MAX_BYTES) {
      diagnostics.push({
        code: "CONTEXT_FILE_TOO_LARGE",
        severity: "error",
        path: `contexts[${index}].file`,
        message: `Context file exceeds ${PROJECT_PROFILE_CONTEXT_FILE_MAX_BYTES} bytes.`,
      });
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      diagnostics.push({
        code: "CONTEXT_FILE_INVALID",
        severity: "error",
        path: `contexts[${index}].file`,
        message: "Context file is not valid UTF-8.",
      });
      continue;
    }
    const logicalPath = normalizeLogicalPath(context.file);
    contexts.push({
      scopeType: "collection",
      scopeKey: `${profile.collection.name}:`,
      text,
      source: { kind: "file", path: logicalPath, sha256: sha256(bytes) },
    });
    contextFiles.push({
      logicalPath,
      absolutePath: resolved.absolutePath,
    });
  }

  diagnostics.push(
    ...(await diagnoseModelPreset(profile, options, profileRoot))
  );
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { ok: false, diagnostics };
  }

  const normalizedContentTypes = normalizeContentTypes(
    profile.contentTypes
  ).rules.map((rule) => ({
    id: rule.id,
    prefixes: sortedUnique(rule.prefixes.map(normalizeLogicalPath)),
    preset: rule.preset,
    ...(rule.graphHints ? { graphHints: sortedUnique(rule.graphHints) } : {}),
    ...(rule.searchBoost === undefined
      ? {}
      : { searchBoost: rule.searchBoost }),
    ...(rule.temporal === undefined ? {} : { temporal: rule.temporal }),
  }));

  const desiredState: ProjectProfileDesiredState = {
    schemaVersion: PROJECT_PROFILE_SCHEMA_VERSION,
    collection: {
      name: profile.collection.name,
      root: normalizeLogicalPath(profile.collection.root),
      include: sortedUnique(
        profile.collection.include.map(normalizeLogicalPath)
      ),
      exclude: sortedUnique([
        ...profile.collection.exclude.map(normalizeLogicalPath),
        ...PROJECT_PROFILE_FORCED_EXCLUDES,
      ]),
      ...(profile.collection.languageHint
        ? { languageHint: profile.collection.languageHint }
        : {}),
      ...(profile.collection.modelPreset
        ? { modelPreset: profile.collection.modelPreset }
        : {}),
    },
    contexts: contexts.sort((left, right) =>
      compareCodeUnits(
        canonicalProjectProfileJson(left),
        canonicalProjectProfileJson(right)
      )
    ),
    contentTypes: normalizedContentTypes,
    affinityDefaults: profile.affinityDefaults,
    recommendedCapabilities: sortedUnique(profile.recommendedCapabilities),
  };
  const canonicalJson = canonicalProjectProfileJson(desiredState);
  return {
    ok: true,
    value: {
      profile,
      desiredState,
      canonicalJson,
      fingerprint: fingerprintProjectProfileState(desiredState),
      resolvedPaths: {
        profileRoot,
        collectionRoot: collectionRoot.ok
          ? collectionRoot.absolutePath
          : profileRoot,
        contextFiles: contextFiles.sort((left, right) =>
          compareCodeUnits(left.logicalPath, right.logicalPath)
        ),
      },
      diagnostics,
    },
  };
}
