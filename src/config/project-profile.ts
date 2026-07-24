import { z } from "zod";

import { NOTE_PRESETS } from "../core/note-presets";
import { hasLikelySecretPath } from "../core/path-rules";
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
const GLOB_TRAVERSAL_PATTERN = /(?:^|[/{,])\.\.(?=$|[/},])/;
const WINDOWS_INVALID_COMPONENT_PATTERN = /[<>:"|]/;
const WINDOWS_RESERVED_COMPONENT_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const RUNTIME_PATH_PATTERN =
  /(?:^|\/)\.gno(?:\/|$)|\.(?:db|sqlite|sqlite3|gguf|lock)$/i;
const NOTE_PRESET_IDS = new Set<string>(
  NOTE_PRESETS.map((preset) => preset.id)
);

const globStructureIssue = (value: string): string | null => {
  if (value.startsWith("!")) {
    return "must not use whole-pattern negation";
  }
  let braceDepth = 0;
  let bracketDepth = 0;
  for (const character of value) {
    if (character === "{") braceDepth += 1;
    else if (character === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) return "contains an unmatched closing brace";
    } else if (character === "[") bracketDepth += 1;
    else if (character === "]") {
      bracketDepth -= 1;
      if (bracketDepth < 0) return "contains an unmatched closing bracket";
    }
    if (braceDepth > 16 || bracketDepth > 16) {
      return "contains excessively nested glob groups";
    }
  }
  if (braceDepth !== 0) return "contains an unmatched opening brace";
  if (bracketDepth !== 0) return "contains an unmatched opening bracket";
  return null;
};

const windowsComponentIssue = (
  normalized: string,
  allowGlob: boolean
): string | null => {
  for (const component of normalized.split("/")) {
    if (component === "." || component === "") continue;
    let hasControlCharacter = false;
    for (const character of component) {
      if ((character.codePointAt(0) ?? 0) < 32) {
        hasControlCharacter = true;
        break;
      }
    }
    if (
      hasControlCharacter ||
      WINDOWS_INVALID_COMPONENT_PATTERN.test(component)
    ) {
      return "contains characters invalid in Windows path components";
    }
    if (component.endsWith(".") || component.endsWith(" ")) {
      return "contains a component ending in a dot or space";
    }
    if (
      (!allowGlob || !GLOB_META_PATTERN.test(component)) &&
      WINDOWS_RESERVED_COMPONENT_PATTERN.test(component)
    ) {
      return "contains a Windows-reserved path component";
    }
  }
  return null;
};

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
  if (
    normalized.split("/").includes("..") ||
    GLOB_TRAVERSAL_PATTERN.test(normalized)
  ) {
    return "must not contain traversal segments";
  }
  const windowsIssue = windowsComponentIssue(normalized, options.allowGlob);
  if (windowsIssue) return windowsIssue;
  if (!options.allowGlob && GLOB_META_PATTERN.test(normalized)) {
    return "must not contain glob metacharacters";
  }
  if (options.allowGlob) {
    const globIssue = globStructureIssue(normalized);
    if (globIssue) return globIssue;
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
      .superRefine((values, context) => {
        const seen = new Set<string>();
        for (const [index, value] of values.entries()) {
          if (seen.has(value)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "Duplicate include rule",
            });
          }
          seen.add(value);
        }
      })
      .default(["**/*"]),
    exclude: z
      .array(
        portablePathSchema({
          allowGlob: true,
          allowRuntimeExclusion: true,
        })
      )
      .max(128)
      .superRefine((values, context) => {
        const seen = new Set<string>();
        for (const [index, value] of values.entries()) {
          if (seen.has(value)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "Duplicate exclude rule",
            });
          }
          seen.add(value);
        }
      })
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
    file: portablePathSchema().superRefine((value, context) => {
      if (hasLikelySecretPath(value)) {
        context.addIssue({
          code: "custom",
          message:
            "UNSAFE_PATH: likely credential and secret files cannot be profile contexts",
        });
      }
    }),
  })
  .strict();

export const ProjectProfileContextSchema = z.union([
  InlineProjectProfileContextSchema,
  FileProjectProfileContextSchema,
]);

export const ProjectProfileContentTypeSchema = z
  .object({
    id: z.string().regex(REFERENCE_PATTERN),
    prefixes: z
      .array(portablePathSchema())
      .min(1)
      .max(64)
      .superRefine((values, context) => {
        const seen = new Set<string>();
        for (const [index, value] of values.entries()) {
          if (seen.has(value)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "Duplicate content type prefix",
            });
          }
          seen.add(value);
        }
      }),
    preset: z
      .string()
      .min(1)
      .refine((value) => NOTE_PRESET_IDS.has(value), "Unknown note preset"),
    graphHints: z
      .array(z.string().min(1).max(64))
      .max(16)
      .superRefine((values, context) => {
        const seen = new Set<string>();
        for (const [index, value] of values.entries()) {
          if (seen.has(value)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "Duplicate graph hint",
            });
          }
          seen.add(value);
        }
      })
      .optional(),
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
    contexts: z
      .array(ProjectProfileContextSchema)
      .max(64)
      .superRefine((values, context) => {
        const seen = new Set<string>();
        for (const [index, value] of values.entries()) {
          const key = JSON.stringify(value);
          if (seen.has(key)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "Duplicate context declaration",
            });
          }
          seen.add(key);
        }
      })
      .default([]),
    contentTypes: z.array(ProjectProfileContentTypeSchema).max(64).default([]),
    affinityDefaults: ProjectProfileAffinityDefaultsSchema.default({
      enabled: true,
      contribution: PROJECT_AFFINITY_MAX_CONTRIBUTION,
    }),
    recommendedCapabilities: z
      .array(z.string().regex(CAPABILITY_PATTERN))
      .max(32)
      .superRefine((values, context) => {
        const seen = new Set<string>();
        for (const [index, value] of values.entries()) {
          if (seen.has(value)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "Duplicate recommended capability",
            });
          }
          seen.add(value);
        }
      })
      .default([]),
  })
  .strict()
  .superRefine((profile, context) => {
    const seenIds = new Set<string>();
    for (const [index, contentType] of profile.contentTypes.entries()) {
      if (seenIds.has(contentType.id)) {
        context.addIssue({
          code: "custom",
          path: ["contentTypes", index, "id"],
          message: `Duplicate content type id "${contentType.id}"`,
        });
      }
      seenIds.add(contentType.id);
    }
  });

export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;
export type ProjectProfileContentType = z.infer<
  typeof ProjectProfileContentTypeSchema
>;
