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
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

import type { Collection, Config } from "../config/types";

import { SESSION_HARNESSES } from "./types";

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
  })
  .strict();

export type SessionsConfig = z.infer<typeof SessionsConfigSchema>;
export type SessionSourceConfig = z.infer<typeof SessionSourceSchema>;

/**
 * Collections a filesystem watcher follows. Session archive collections are
 * written and synced only by the importer; a watcher re-syncing them would
 * duplicate that work on the server's event loop and contend for the index
 * write lock with the import.
 */
export function watchedCollections(config: Config): Collection[] {
  const archiveRoot = config.sessions?.archiveRoot;
  if (!archiveRoot) return config.collections;
  const root = resolve(archiveRoot);
  return config.collections.filter((collection) => {
    const rel = relative(root, resolve(collection.path));
    return rel.startsWith("..") || isAbsolute(rel);
  });
}
