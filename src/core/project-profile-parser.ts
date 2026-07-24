import type { ProjectProfile } from "../config/project-profile";
import type {
  CompileProjectProfileResult,
  ProjectProfileDiagnostic,
} from "./project-profile";

import {
  PROJECT_PROFILE_SCHEMA_VERSION,
  ProjectProfileSchema,
} from "../config/project-profile";

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
  if (parsed === null || typeof parsed !== "object") return null;
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

export const parseProjectProfile = (
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
  if (result.success) return result.data;
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
};
