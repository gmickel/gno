/**
 * `sessions` block of a dedicated session-archive configuration file.
 *
 * The block binds the config file to one named index and one archive root,
 * and lists owner-registered sources. It only ever appears in the archive
 * config; the curated default config never carries archive collections.
 *
 * @module src/sessions/config
 */

// node:path isAbsolute: no Bun path utilities.
import { isAbsolute } from "node:path";
import { z } from "zod";

import { MAX_IMPORT_LIMIT, SESSION_HARNESSES } from "./types";

const COLLECTION_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SOURCE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), { message: "Path must be absolute" });

const SessionProjectMappingSchema = z
  .object({
    /** Working-directory prefix (absolute) this mapping applies to. */
    prefix: AbsolutePathSchema,
    /** Archive collection that receives threads recorded under the prefix. */
    collection: z.string().regex(COLLECTION_NAME),
  })
  .strict();

export const SessionSourceSchema = z
  .object({
    id: z
      .string()
      .regex(
        SOURCE_ID,
        "Source ID must be lowercase alphanumeric with hyphens/underscores, 1-64 chars"
      ),
    harness: z.enum(SESSION_HARNESSES),
    /** Absolute harness session root, file or database. */
    path: AbsolutePathSchema,
    /** Default archive collection for this source. */
    collection: z.string().regex(COLLECTION_NAME),
    /** Owner-approved working-directory mappings to other archive collections. */
    projects: z.array(SessionProjectMappingSchema).max(64).optional(),
  })
  .strict();

/** Host hooks GNO can install. Only verified integrations are listed. */
export const SESSION_HOOK_HARNESSES = ["claude-code"] as const;
export type SessionHookHarness = (typeof SESSION_HOOK_HARNESSES)[number];

/**
 * Owner-controlled automation profile. Every trigger is off until the owner
 * enables it explicitly; nothing here is ever switched on by install,
 * upgrade, repair or restart. Destinations and privacy routing stay on the
 * referenced sources (collection + project mappings), never on the profile.
 */
export const SessionAutomationProfileSchema = z
  .object({
    id: z
      .string()
      .regex(
        SOURCE_ID,
        "Profile ID must be lowercase alphanumeric with hyphens/underscores, 1-64 chars"
      ),
    /** Registered source IDs this profile imports. */
    sources: z
      .array(z.string().regex(SOURCE_ID))
      .min(1)
      .max(64)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Profile sources must be unique",
      }),
    hook: z
      .object({
        harness: z.enum(SESSION_HOOK_HARNESSES),
        enabled: z.boolean(),
        /** Absolute host settings file that holds the owned hook entry. */
        settings: AbsolutePathSchema,
      })
      .strict()
      .optional(),
    schedule: z
      .object({
        enabled: z.boolean(),
        /** Elapsed cadence `<n>s|m|h|d`; validated by the automation module. */
        cadence: z.string().min(2).max(8),
      })
      .strict()
      .optional(),
    /** Changed units imported per source per run (bounded work budget). */
    limit: z.number().int().min(1).max(MAX_IMPORT_LIMIT).optional(),
    /** Automatic retries after a failed run before waiting for a new trigger. */
    retries: z.number().int().min(0).max(10).optional(),
  })
  .strict();

export type SessionAutomationProfile = z.infer<
  typeof SessionAutomationProfileSchema
>;

export const SessionsConfigSchema = z
  .object({
    /** Index name this archive config is bound to. */
    index: z.string().min(1).max(64),
    /** Durable archive root (absolute). Collections live directly below it. */
    archiveRoot: AbsolutePathSchema,
    sources: z
      .array(SessionSourceSchema)
      .max(64)
      .default([])
      .superRefine((sources, ctx) => {
        const ids = new Set<string>();
        for (const [index, source] of sources.entries()) {
          if (ids.has(source.id)) {
            ctx.addIssue({
              code: "custom",
              message: "Session source IDs must be unique",
              path: [index, "id"],
            });
          }
          ids.add(source.id);
        }
      }),
    redaction: z
      .object({
        /** Exact literals always redacted (e.g. internal hostnames, known keys). */
        literals: z.array(z.string().min(4).max(512)).max(256).default([]),
      })
      .strict()
      .optional(),
    /** Opt-in automation profiles (hooks and daemon schedules). */
    automation: z
      .array(SessionAutomationProfileSchema)
      .max(16)
      .optional()
      .superRefine((profiles, ctx) => {
        const ids = new Set<string>();
        for (const [index, profile] of (profiles ?? []).entries()) {
          if (ids.has(profile.id)) {
            ctx.addIssue({
              code: "custom",
              message: "Automation profile IDs must be unique",
              path: [index, "id"],
            });
          }
          ids.add(profile.id);
        }
      }),
  })
  .strict();

export type SessionsConfig = z.infer<typeof SessionsConfigSchema>;
export type SessionSourceConfig = z.infer<typeof SessionSourceSchema>;
