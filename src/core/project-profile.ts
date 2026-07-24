// node:fs/promises provides realpath; Bun has no equivalent for symlink-safe path identity.
import { realpath } from "node:fs/promises";
// node:path provides cross-platform path operations; Bun has no path utilities.
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Config, ModelPreset } from "../config/types";

import { normalizeContentTypes } from "../config/content-types";
import { createDefaultConfig } from "../config/defaults";
import {
  PROJECT_PROFILE_FINGERPRINT_DOMAIN,
  PROJECT_PROFILE_FORCED_EXCLUDES,
  PROJECT_PROFILE_SCHEMA_VERSION,
  type ProjectProfile,
  ProjectProfileSchema,
} from "../config/project-profile";
import { getPreset } from "../llm/registry";
export type ProjectProfileDiagnosticCode =
  | "CONTEXT_FILE_INVALID"
  | "CONTEXT_FILE_UNREADABLE"
  | "INVALID_PROFILE"
  | "MIGRATION_REQUIRED"
  | "MODEL_CACHE_CHECK_FAILED"
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

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const normalizeLogicalPath = (value: string): string => {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized || ".";
};

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareCodeUnits);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) sorted[key] = canonicalize(child);
    }
    return sorted;
  }
  return value;
};

export const canonicalProjectProfileJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

/** Encode one or more portable include globs into the config's single pattern. */
export const projectProfileIncludePattern = (
  include: readonly string[]
): string =>
  include.length === 1 ? (include[0] ?? "**/*") : `{${include.join(",")}}`;

const sha256 = (value: string | Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

export const fingerprintProjectProfileState = (
  desiredState: ProjectProfileDesiredState
): string =>
  sha256(
    `${PROJECT_PROFILE_FINGERPRINT_DOMAIN}${canonicalProjectProfileJson(
      desiredState
    )}`
  );

const isContained = (parent: string, candidate: string): boolean => {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
};

const zodPath = (segments: PropertyKey[]): string => {
  let path = "";
  for (const segment of segments) {
    const value = String(segment);
    path =
      typeof segment === "number"
        ? `${path}[${value}]`
        : path
          ? `${path}.${value}`
          : value;
  }
  return path;
};

const versionDiagnostic = (
  parsed: unknown
): ProjectProfileDiagnostic | null => {
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  if (!("schemaVersion" in parsed)) {
    return {
      code: "MIGRATION_REQUIRED",
      severity: "error",
      path: "schemaVersion",
      message: `Project profile has no schemaVersion; migrate it to version ${PROJECT_PROFILE_SCHEMA_VERSION}.`,
    };
  }
  const found = String(parsed.schemaVersion);
  const match = /^(\d+)\.(\d+)$/.exec(found);
  if (!match || match[1] !== "1") {
    return {
      code: "UNSUPPORTED_SCHEMA_MAJOR",
      severity: "error",
      path: "schemaVersion",
      message: `Unsupported project profile major version "${found}"; expected 1.x.`,
    };
  }
  if (found !== PROJECT_PROFILE_SCHEMA_VERSION) {
    return {
      code: "UNSUPPORTED_SCHEMA_MINOR",
      severity: "error",
      path: "schemaVersion",
      message: `Project profile version "${found}" requires migration to supported version ${PROJECT_PROFILE_SCHEMA_VERSION}.`,
    };
  }
  return null;
};

const parseProfile = (
  yaml: string
): CompileProjectProfileResult | ProjectProfile => {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yaml);
  } catch {
    return {
      ok: false,
      diagnostics: [
        {
          code: "INVALID_PROFILE",
          severity: "error",
          path: "",
          message: "Project profile is not valid YAML.",
        },
      ],
    };
  }

  const versionIssue = versionDiagnostic(parsed);
  if (versionIssue) return { ok: false, diagnostics: [versionIssue] };

  const result = ProjectProfileSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      diagnostics: result.error.issues.map((issue) => {
        const unsafePath = issue.message.startsWith("UNSAFE_PATH:");
        return {
          code: unsafePath ? "UNSAFE_PATH" : "INVALID_PROFILE",
          severity: "error",
          path: zodPath(issue.path),
          message: unsafePath
            ? issue.message.slice("UNSAFE_PATH:".length).trim()
            : issue.message,
        };
      }),
    };
  }
  return result.data;
};

const resolveContainedPath = async (
  profileRoot: string,
  logicalPath: string,
  diagnosticPath: string
): Promise<
  | { ok: true; absolutePath: string }
  | { ok: false; diagnostic: ProjectProfileDiagnostic }
> => {
  const candidate = resolve(profileRoot, normalizeLogicalPath(logicalPath));
  let absolutePath: string;
  try {
    absolutePath = await realpath(candidate);
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
  return { ok: true, absolutePath };
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
  options: ProjectProfileCompilerOptions
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
  const parsed = parseProfile(yaml);
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
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(
        await Bun.file(resolved.absolutePath).arrayBuffer()
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

  diagnostics.push(...(await diagnoseModelPreset(profile, options)));
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
