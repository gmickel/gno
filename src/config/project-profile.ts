import { z } from "zod";

import { NOTE_PRESETS } from "../core/note-presets";
import {
  isValidLanguageHint,
  PROJECT_AFFINITY_MAX_CONTRIBUTION,
} from "./types";

export const PROJECT_PROFILE_SCHEMA_VERSION = "1.0" as const;
export const PROJECT_PROFILE_FINGERPRINT_DOMAIN = "gno-project-profile\0v1.0\0";
export const PROJECT_PROFILE_FORCED_EXCLUDES = [".gno"] as const;

const COLLECTION_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REFERENCE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[a-z]:/i;
const WINDOWS_UNC_PATH_PATTERN = /^(?:\\\\|\/\/)/;
const ENV_EXPANSION_PATTERN =
  /(?:\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%)/;
const GLOB_META_PATTERN = /[*?[\]{}]/;
const RUNTIME_PATH_PATTERN =
  /(?:^|\/)\.gno(?:\/|$)|\.(?:db|sqlite|sqlite3|gguf|lock)$/i;
const NOTE_PRESET_IDS = new Set<string>(
  NOTE_PRESETS.map((preset) => preset.id)
);

const portablePathIssue = (
  value: string,
  options: { allowGlob: boolean; allowRuntimeExclusion: boolean }
): string | null => {
  if (value.includes("\0")) return "contains a NUL byte";
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    WINDOWS_UNC_PATH_PATTERN.test(value) ||
    WINDOWS_DRIVE_PATH_PATTERN.test(value) ||
    value.startsWith("~")
  ) {
    return "must be repository-relative on every supported platform";
  }
  if (ENV_EXPANSION_PATTERN.test(value)) {
    return "must not contain environment expansion";
  }

  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) {
    return "must not contain traversal segments";
  }
  if (!options.allowGlob && GLOB_META_PATTERN.test(normalized)) {
    return "must not contain glob metacharacters";
  }
  if (!options.allowRuntimeExclusion && RUNTIME_PATH_PATTERN.test(normalized)) {
    return "must not reference GNO runtime state";
  }
  return null;
};

const portablePathSchema = (
  options: { allowGlob?: boolean; allowRuntimeExclusion?: boolean } = {}
) =>
  z
    .string()
    .min(1)
    .max(512)
    .superRefine((value, context) => {
      const issue = portablePathIssue(value, {
        allowGlob: options.allowGlob ?? false,
        allowRuntimeExclusion: options.allowRuntimeExclusion ?? false,
      });
      if (issue) {
        context.addIssue({
          code: "custom",
          message: `UNSAFE_PATH: ${issue}`,
        });
      }
    });

export const ProjectProfileCollectionSchema = z
  .object({
    name: z.string().regex(COLLECTION_NAME_PATTERN),
    root: portablePathSchema().default("."),
    include: z
      .array(portablePathSchema({ allowGlob: true }))
      .min(1)
      .max(128)
      .default(["**/*"]),
    exclude: z
      .array(
        portablePathSchema({
          allowGlob: true,
          allowRuntimeExclusion: true,
        })
      )
      .max(128)
      .default([]),
    languageHint: z
      .string()
      .refine(isValidLanguageHint, "Invalid BCP-47 language hint")
      .optional(),
    modelPreset: z.string().regex(REFERENCE_PATTERN).optional(),
  })
  .strict();

const InlineProjectProfileContextSchema = z
  .object({
    text: z.string().min(1).max(65_536),
  })
  .strict();

const FileProjectProfileContextSchema = z
  .object({
    file: portablePathSchema(),
  })
  .strict();

export const ProjectProfileContextSchema = z.union([
  InlineProjectProfileContextSchema,
  FileProjectProfileContextSchema,
]);

export const ProjectProfileContentTypeSchema = z
  .object({
    id: z.string().regex(REFERENCE_PATTERN),
    prefixes: z.array(portablePathSchema()).min(1).max(64),
    preset: z
      .string()
      .min(1)
      .refine((value) => NOTE_PRESET_IDS.has(value), "Unknown note preset"),
    graphHints: z.array(z.string().min(1).max(64)).max(16).optional(),
    searchBoost: z.number().finite().optional(),
    temporal: z.boolean().optional(),
  })
  .strict();

export const ProjectProfileAffinityDefaultsSchema = z
  .object({
    enabled: z.boolean().default(true),
    contribution: z
      .number()
      .finite()
      .min(0)
      .max(PROJECT_AFFINITY_MAX_CONTRIBUTION)
      .default(PROJECT_AFFINITY_MAX_CONTRIBUTION),
  })
  .strict();

export const ProjectProfileSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_PROFILE_SCHEMA_VERSION),
    collection: ProjectProfileCollectionSchema,
    contexts: z.array(ProjectProfileContextSchema).max(64).default([]),
    contentTypes: z.array(ProjectProfileContentTypeSchema).max(64).default([]),
    affinityDefaults: ProjectProfileAffinityDefaultsSchema.default({
      enabled: true,
      contribution: PROJECT_AFFINITY_MAX_CONTRIBUTION,
    }),
    recommendedCapabilities: z
      .array(z.string().regex(CAPABILITY_PATTERN))
      .max(32)
      .default([]),
  })
  .strict();

export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;
export type ProjectProfileContentType = z.infer<
  typeof ProjectProfileContentTypeSchema
>;
