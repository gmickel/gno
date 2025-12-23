/**
 * Config schema definitions using Zod.
 * Defines Collection, Context, and Config types for GNO.
 *
 * @module src/config/types
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Current config version */
export const CONFIG_VERSION = '1.0';

/** Default glob pattern for file matching */
export const DEFAULT_PATTERN = '**/*';

/** Default exclude patterns for collections */
export const DEFAULT_EXCLUDES: readonly string[] = [
  '.git',
  'node_modules',
  '.venv',
  '.idea',
  'dist',
  'build',
  '__pycache__',
  '.DS_Store',
  'Thumbs.db',
];

/** Valid FTS tokenizer options */
export const FTS_TOKENIZERS = ['unicode61', 'porter', 'trigram'] as const;
export type FtsTokenizer = (typeof FTS_TOKENIZERS)[number];

/** Default FTS tokenizer */
export const DEFAULT_FTS_TOKENIZER: FtsTokenizer = 'unicode61';

/**
 * BCP-47 language tag pattern (simplified, case-insensitive).
 * Matches: en, de, fr, zh-CN, zh-Hans, und, en-US, etc.
 */
const BCP47_PATTERN = /^[a-z]{2,3}(-[a-z]{2}|-[a-z]{4})?$/i;

/** Validate BCP-47 language hint */
export function isValidLanguageHint(hint: string): boolean {
  return BCP47_PATTERN.test(hint);
}

// ─────────────────────────────────────────────────────────────────────────────
// Collection Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collection name pattern: lowercase alphanumeric, hyphens, underscores.
 * 1-64 chars, must start with alphanumeric.
 */
const COLLECTION_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Collection scope key pattern: name (1-64 chars) followed by colon */
const COLLECTION_SCOPE_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}:$/;

export const CollectionSchema = z.object({
  /** Unique collection identifier (lowercase) */
  name: z
    .string()
    .regex(
      COLLECTION_NAME_REGEX,
      'Collection name must be lowercase alphanumeric with hyphens/underscores, 1-64 chars'
    ),

  /** Absolute path to collection root */
  path: z.string().min(1, 'Path is required'),

  /** Glob pattern for file matching */
  pattern: z.string().default(DEFAULT_PATTERN),

  /** Extension allowlist (empty = all) */
  include: z.array(z.string()).default([]),

  /** Path patterns to skip */
  exclude: z.array(z.string()).default([...DEFAULT_EXCLUDES]),

  /** Optional shell command to run before indexing */
  updateCmd: z.string().optional(),

  /** Optional BCP-47 language hint */
  languageHint: z
    .string()
    .refine((val) => isValidLanguageHint(val), {
      message: 'Invalid BCP-47 language code (e.g., en, de, zh-CN, und)',
    })
    .optional(),
});

export type Collection = z.infer<typeof CollectionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Context Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context scope types:
 * - global: "/" - applies to all documents
 * - collection: "name:" - applies to a specific collection
 * - prefix: "gno://collection/path" - applies to documents under a path
 */
export const ScopeTypeSchema = z.enum(['global', 'collection', 'prefix']);
export type ScopeType = z.infer<typeof ScopeTypeSchema>;

/**
 * Validate scope key format based on type.
 * - global: must be "/"
 * - collection: must be "name:" format
 * - prefix: must be "gno://collection/path" format
 */
export const ContextSchema = z
  .object({
    /** Type of scope */
    scopeType: ScopeTypeSchema,

    /** Scope key (format depends on scopeType) */
    scopeKey: z.string().min(1, 'Scope key is required'),

    /** Context description text */
    text: z.string().min(1, 'Context text is required'),
  })
  .refine(
    (ctx) => {
      switch (ctx.scopeType) {
        case 'global':
          return ctx.scopeKey === '/';
        case 'collection':
          return COLLECTION_SCOPE_REGEX.test(ctx.scopeKey);
        case 'prefix':
          return ctx.scopeKey.startsWith('gno://');
        default:
          return false;
      }
    },
    {
      message: 'Scope key format does not match scope type',
    }
  );

export type Context = z.infer<typeof ContextSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Config Schema (root)
// ─────────────────────────────────────────────────────────────────────────────

export const ConfigSchema = z.object({
  /** Config schema version */
  version: z.literal(CONFIG_VERSION),

  /** FTS tokenizer (immutable after init) */
  ftsTokenizer: z.enum(FTS_TOKENIZERS).default(DEFAULT_FTS_TOKENIZER),

  /** Collection definitions */
  collections: z.array(CollectionSchema).default([]),

  /** Context metadata */
  contexts: z.array(ContextSchema).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Scope Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a scope string into type and key.
 * Input formats (from CLI):
 * - "/" -> { type: 'global', key: '/' }
 * - "notes:" -> { type: 'collection', key: 'notes:' }
 * - "gno://notes/projects" -> { type: 'prefix', key: 'gno://notes/projects' }
 */
export function parseScope(
  scope: string
): { type: ScopeType; key: string } | null {
  if (scope === '/') {
    return { type: 'global', key: '/' };
  }
  if (scope.startsWith('gno://')) {
    return { type: 'prefix', key: scope };
  }
  if (COLLECTION_SCOPE_REGEX.test(scope)) {
    return { type: 'collection', key: scope };
  }
  return null;
}

/**
 * Extract collection name from a scope key.
 * - "notes:" -> "notes"
 * - "gno://notes/path" -> "notes"
 * - "/" -> null
 */
export function getCollectionFromScope(scopeKey: string): string | null {
  if (scopeKey === '/') {
    return null;
  }
  if (scopeKey.endsWith(':')) {
    return scopeKey.slice(0, -1);
  }
  if (scopeKey.startsWith('gno://')) {
    const rest = scopeKey.slice(6); // Remove "gno://"
    const slashIndex = rest.indexOf('/');
    return slashIndex === -1 ? rest : rest.slice(0, slashIndex);
  }
  return null;
}
