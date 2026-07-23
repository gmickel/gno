/**
 * Runtime validation and closed projection for publish artifact builders.
 *
 * @module src/publish/artifact-validation
 */

export const MAX_PUBLISH_SLUG_LENGTH = 80;

const PUBLISH_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/u;

const SOURCE_TYPES = new Set(["collection", "note"]);
const READER_VISIBILITIES = new Set(["invite-only", "public", "secret-link"]);

export interface ValidatedPublishNote {
  markdown: string;
  metadata?: Record<string, string | string[]>;
  slug: string;
  summary: string;
  title: string;
}

export interface ValidatedPublishSpaceInput {
  homeNoteSlug?: string;
  notes: ValidatedPublishNote[];
  routeSlug: string;
  sourceType: "note" | "collection";
  summary: string;
  title: string;
  visibility: "invite-only" | "public" | "secret-link";
}

const requireRecord = (
  value: unknown,
  field: string
): Record<string, unknown> => {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
};

const requireNonblankString = (value: unknown, field: string): string => {
  const result = requireString(value, field);
  if (result.trim().length === 0) {
    throw new Error(`${field} must not be blank`);
  }
  return result;
};

const requireSlug = (value: unknown, field: string): string => {
  const result = requireString(value, field);
  if (!PUBLISH_SLUG_PATTERN.test(result)) {
    throw new Error(`${field} must be a valid publish slug`);
  }
  return result;
};

const projectMetadata = (
  value: unknown,
  field: string
): Record<string, string | string[]> | undefined => {
  if (value === undefined) return undefined;

  const input = requireRecord(value, field);
  const result: Record<string, string | string[]> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (typeof entry === "string") {
      result[key] = entry;
      continue;
    }
    if (
      Array.isArray(entry) &&
      entry.every((item): item is string => typeof item === "string")
    ) {
      result[key] = [...entry];
      continue;
    }
    throw new Error(`${field}.${key} must be a string or string array`);
  }
  return result;
};

const projectNote = (value: unknown, index: number): ValidatedPublishNote => {
  const field = `notes[${index}]`;
  const input = requireRecord(value, field);
  const metadata = projectMetadata(input.metadata, `${field}.metadata`);
  const note: ValidatedPublishNote = {
    markdown: requireString(input.markdown, `${field}.markdown`),
    slug: requireSlug(input.slug, `${field}.slug`),
    summary: requireString(input.summary, `${field}.summary`),
    title: requireNonblankString(input.title, `${field}.title`),
  };
  if (metadata !== undefined) note.metadata = metadata;
  return note;
};

export const validateAndProjectPublishSpaceInput = (
  value: unknown
): ValidatedPublishSpaceInput => {
  const input = requireRecord(value, "publish input");
  if (!Array.isArray(input.notes) || input.notes.length === 0) {
    throw new Error("Publish input must contain at least one note");
  }

  const notes = input.notes.map(projectNote);
  const noteSlugs = new Set<string>();
  for (const note of notes) {
    if (noteSlugs.has(note.slug)) {
      throw new Error(
        `Publish input contains duplicate note slug "${note.slug}"`
      );
    }
    noteSlugs.add(note.slug);
  }

  const routeSlug = requireSlug(input.routeSlug, "routeSlug");
  const sourceType = requireString(input.sourceType, "sourceType");
  if (!SOURCE_TYPES.has(sourceType)) {
    throw new Error('sourceType must be "note" or "collection"');
  }

  const visibility = requireString(input.visibility, "visibility");
  if (!READER_VISIBILITIES.has(visibility)) {
    throw new Error(
      'visibility must be "public", "secret-link", or "invite-only"'
    );
  }

  const homeNoteSlug =
    input.homeNoteSlug === undefined
      ? undefined
      : requireSlug(input.homeNoteSlug, "homeNoteSlug");
  if (homeNoteSlug !== undefined && !noteSlugs.has(homeNoteSlug)) {
    throw new Error(`homeNoteSlug "${homeNoteSlug}" is not present in notes`);
  }

  const result: ValidatedPublishSpaceInput = {
    notes,
    routeSlug,
    sourceType: sourceType as "note" | "collection",
    summary: requireString(input.summary, "summary"),
    title: requireNonblankString(input.title, "title"),
    visibility: visibility as ValidatedPublishSpaceInput["visibility"],
  };
  if (homeNoteSlug !== undefined) result.homeNoteSlug = homeNoteSlug;
  return result;
};

export const requirePublishDateTime = (
  value: unknown,
  field = "exportedAt"
): string => {
  const result = requireString(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}T/u.test(result) ||
    Number.isNaN(Date.parse(result))
  ) {
    throw new Error(`${field} must be a valid date-time`);
  }
  return result;
};
