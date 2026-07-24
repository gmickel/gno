import { z } from "zod";

export const BROWSER_CLIP_SCHEMA_VERSION = "1.0" as const;
export const BROWSER_CLIP_MAX_BYTES = 512 * 1024;

export const BROWSER_CLIP_WARNING_CODES = [
  "authenticated_visible_content",
  "canonical_url_differs",
  "edited_content",
  "line_endings_normalized",
  "reader_partial",
  "selection_truncated",
  "spa_snapshot",
  "unicode_normalized",
] as const;

const hasDisallowedControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 8 ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        (codePoint >= 127 && codePoint <= 159))
    ) {
      return true;
    }
  }
  return false;
};

export const findDisallowedBrowserClipControlPath = (
  value: unknown,
  path: Array<string | number> = []
): Array<string | number> | null => {
  if (typeof value === "string") {
    return hasDisallowedControlCharacter(value) ? path : null;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const match = findDisallowedBrowserClipControlPath(child, [
        ...path,
        index,
      ]);
      if (match !== null) return match;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const match = findDisallowedBrowserClipControlPath(child, [...path, key]);
      if (match !== null) return match;
    }
  }
  return null;
};

const httpUrlSchema = z
  .string()
  .max(4096)
  .superRefine((value, context) => {
    try {
      const url = new URL(value);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username ||
        url.password ||
        !url.hostname
      ) {
        context.addIssue({
          code: "custom",
          message: "URL must be HTTP(S), credential-free, and absolute",
        });
      }
    } catch {
      context.addIssue({ code: "custom", message: "URL must be absolute" });
    }
  });

const publishedAtSchema = z.union([
  z.string().date(),
  z.string().datetime({ offset: true }),
]);

const browserSchema = z
  .object({
    name: z.string().min(1).max(128),
    version: z.string().max(128).nullable(),
    platform: z.string().max(128).nullable(),
  })
  .strict();

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const browserClipProvenanceSchema = z
  .object({
    schemaVersion: z.literal(BROWSER_CLIP_SCHEMA_VERSION),
    mode: z.enum(["selection", "reader"]),
    sourceUrl: httpUrlSchema,
    canonicalUrl: httpUrlSchema.nullable(),
    title: z.string().min(1).max(2048),
    author: z.string().max(1024).nullable(),
    site: z.string().max(1024).nullable(),
    publishedAt: publishedAtSchema.nullable(),
    observedAt: z.string().datetime({ offset: true }),
    capturedAt: z.string().datetime({ offset: true }),
    extractionHash: sha256Schema,
    finalBodyHash: sha256Schema,
    clipIdentity: sha256Schema,
    previewDigest: sha256Schema,
    exactSelection: z.string().min(1).max(BROWSER_CLIP_MAX_BYTES).nullable(),
    extractionWarnings: z.array(z.enum(BROWSER_CLIP_WARNING_CODES)).max(16),
    browser: browserSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const controlPath = findDisallowedBrowserClipControlPath(value);
    if (controlPath !== null) {
      context.addIssue({
        code: "custom",
        message: "Browser clip text cannot contain C0 or C1 control characters",
        path: controlPath,
      });
    }
    if (
      new Set(value.extractionWarnings).size !== value.extractionWarnings.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Warning codes must be unique",
        path: ["extractionWarnings"],
      });
    }
    if (
      (value.mode === "selection" && value.exactSelection === null) ||
      (value.mode === "reader" && value.exactSelection !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Exact selection must match the extraction mode",
        path: ["exactSelection"],
      });
    }
  });

export type BrowserClipProvenance = z.infer<typeof browserClipProvenanceSchema>;
export type BrowserClipWarningCode =
  (typeof BROWSER_CLIP_WARNING_CODES)[number];
