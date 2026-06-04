/**
 * Shared capture planning, provenance, and receipt contracts.
 *
 * Server-side capture adapters call this before transport-specific write/sync.
 *
 * @module src/core/capture
 */

// node:path has no Bun equivalent
import { posix as pathPosix } from "node:path";

import { buildUri } from "../app/constants";
import {
  resolveNoteCreatePlan,
  type NoteCollisionPolicy,
} from "./note-creation";
import {
  getNotePreset,
  resolveNotePreset,
  type NotePresetId,
} from "./note-presets";
import { normalizeTag, validateTag } from "./tags";
import { validateRelPath } from "./validation";

export const CAPTURE_MAX_TEXT_BYTES = 1024 * 1024;

export type CaptureSourceKind =
  | "direct"
  | "web"
  | "email"
  | "meeting"
  | "chat"
  | "file"
  | "api"
  | "unknown";

export type CaptureStatus =
  | "not_requested"
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "failed"
  | "unknown";

export type CaptureCollisionPolicyResult =
  | "created"
  | "opened_existing"
  | "created_with_suffix"
  | "overwritten"
  | "conflict";

export interface CaptureSource {
  kind: CaptureSourceKind;
  title?: string;
  url?: string;
  uri?: string;
  docid?: string;
  mime?: string;
  ext?: string;
  author?: string;
  observedAt?: string;
  capturedAt: string;
  externalId?: string;
}

export interface CaptureIndexStatus {
  status: CaptureStatus;
  jobId?: string | null;
  reason?: string;
  error?: string;
}

export interface CaptureReceipt {
  uri: string;
  docid?: string;
  collection: string;
  relPath: string;
  absPath?: string;
  created: boolean;
  openedExisting: boolean;
  createdWithSuffix: boolean;
  overwritten?: boolean;
  contentHash: string;
  source: CaptureSource;
  tags: string[];
  sync: CaptureIndexStatus;
  embed: CaptureIndexStatus;
  collisionPolicyResult: CaptureCollisionPolicyResult;
  serverInstanceId?: string;
}

export interface CaptureInput {
  collection: string;
  content?: string;
  title?: string;
  relPath?: string;
  folderPath?: string;
  collisionPolicy?: NoteCollisionPolicy;
  presetId?: NotePresetId;
  tags?: string[];
  source?: Partial<CaptureSource>;
  overwrite?: boolean;
}

export interface CapturePlan {
  collection: string;
  relPath: string;
  filename: string;
  content: string;
  body: string;
  contentHash: string;
  title: string;
  tags: string[];
  source: CaptureSource;
  openedExisting: boolean;
  createdWithSuffix: boolean;
  collisionPolicy: NoteCollisionPolicy;
  collisionPolicyResult: CaptureCollisionPolicyResult;
}

export interface PlanCaptureOptions {
  input: CaptureInput;
  existingRelPaths: Iterable<string>;
  diskRelPaths?: Iterable<string>;
  now?: Date;
}

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n|$)/;
const VALID_SOURCE_KINDS = new Set<CaptureSourceKind>([
  "direct",
  "web",
  "email",
  "meeting",
  "chat",
  "file",
  "api",
  "unknown",
]);
const URL_SOURCE_FIELDS = new Set(["url", "uri"]);
const LEGACY_SOURCE_FIELD_MAP: Record<string, keyof CaptureSource> = {
  gno_source_docid: "docid",
  gno_source_uri: "uri",
  gno_source_mime: "mime",
  gno_source_ext: "ext",
};
const CAPTURE_SOURCE_STRING_KEYS = new Set([
  "title",
  "url",
  "uri",
  "docid",
  "mime",
  "ext",
  "author",
  "externalId",
]);

function normalizeContentForHash(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

export function hashCaptureContent(content: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(normalizeContentForHash(content))
    .digest("hex");
}

function validateTextContent(content: string): void {
  if (content.includes("\0")) {
    throw new Error("Capture content contains a NUL byte.");
  }
  if (new TextEncoder().encode(content).byteLength > CAPTURE_MAX_TEXT_BYTES) {
    throw new Error(
      `Capture content exceeds ${CAPTURE_MAX_TEXT_BYTES} byte limit.`
    );
  }
}

function normalizeIsoDate(value: string, field: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} must be an ISO-like date/time.`);
  }
  return parsed.toISOString();
}

function normalizeSource(
  source: Partial<CaptureSource> | undefined,
  capturedAt: string
): CaptureSource {
  const kind = source?.kind ?? "direct";
  if (!VALID_SOURCE_KINDS.has(kind)) {
    throw new Error(`Unsupported source.kind: ${kind}`);
  }

  const normalized: CaptureSource = {
    kind,
    capturedAt,
  };

  for (const [key, value] of Object.entries(source ?? {})) {
    if (value === undefined || value === null || key === "kind") {
      continue;
    }
    if (key === "capturedAt") {
      normalized.capturedAt = normalizeIsoDate(
        String(value),
        "source.capturedAt"
      );
      continue;
    }
    if (key === "observedAt") {
      normalized.observedAt = normalizeIsoDate(
        String(value),
        "source.observedAt"
      );
      continue;
    }
    if (URL_SOURCE_FIELDS.has(key)) {
      try {
        new URL(String(value));
      } catch {
        throw new Error(`source.${key} must be a valid URL.`);
      }
    }
    if (CAPTURE_SOURCE_STRING_KEYS.has(key)) {
      normalized[
        key as keyof Pick<
          CaptureSource,
          | "title"
          | "url"
          | "uri"
          | "docid"
          | "mime"
          | "ext"
          | "author"
          | "externalId"
        >
      ] = String(value);
    }
  }

  return normalized;
}

function normalizeCaptureTags(tags: string[] | undefined): string[] {
  const normalized: string[] = [];
  for (const tag of tags ?? []) {
    const value = normalizeTag(tag);
    if (!validateTag(value)) {
      throw new Error(
        `Invalid tag "${tag}". Tags must be lowercase, alphanumeric with hyphens/dots/slashes.`
      );
    }
    normalized.push(value);
  }
  return [...new Set(normalized)];
}

function chooseTitle(input: CaptureInput, fallback: string): string {
  return (
    input.title?.trim() ||
    input.source?.title?.trim() ||
    pathPosix.basename(input.relPath ?? "").replace(/\.[^.]+$/u, "") ||
    fallback
  );
}

function generatedCaptureRelPath(
  capturedAt: string,
  contentHash: string
): string {
  const day = capturedAt.slice(0, 10);
  return `inbox/${day}/capture-${contentHash.slice(0, 12)}.md`;
}

function buildExistingSet(
  indexedRelPaths: Iterable<string>,
  diskRelPaths: Iterable<string> | undefined
): Set<string> {
  const existing = new Set<string>();
  for (const relPath of indexedRelPaths) {
    existing.add(validateRelPath(relPath));
  }
  for (const relPath of diskRelPaths ?? []) {
    existing.add(validateRelPath(relPath));
  }
  return existing;
}

function splitFrontmatter(source: string): {
  lines: string[];
  body: string;
  hasFrontmatter: boolean;
} {
  const match = FRONTMATTER_REGEX.exec(source);
  if (!match) {
    return { lines: [], body: source, hasFrontmatter: false };
  }
  return {
    lines: (match[1] ?? "").split("\n"),
    body: source.slice(match[0].length),
    hasFrontmatter: true,
  };
}

function stripYamlString(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function extractCaptureSourceFromFrontmatter(
  content: string
): Partial<CaptureSource> {
  const { lines } = splitFrontmatter(content);
  const source: Partial<CaptureSource> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) {
      continue;
    }
    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    const legacyKey = LEGACY_SOURCE_FIELD_MAP[key];
    if (legacyKey && rawValue) {
      switch (legacyKey) {
        case "docid":
          source.docid = stripYamlString(rawValue);
          break;
        case "uri":
          source.uri = stripYamlString(rawValue);
          break;
        case "mime":
          source.mime = stripYamlString(rawValue);
          break;
        case "ext":
          source.ext = stripYamlString(rawValue);
          break;
      }
      continue;
    }
    if (key !== "source") {
      continue;
    }
    for (
      let nestedIndex = index + 1;
      nestedIndex < lines.length;
      nestedIndex += 1
    ) {
      const nested = lines[nestedIndex];
      if (!nested?.startsWith("  ")) {
        break;
      }
      const nestedColon = nested.indexOf(":");
      if (nestedColon <= 0) {
        continue;
      }
      const nestedKey = nested
        .slice(0, nestedColon)
        .trim() as keyof CaptureSource;
      const nestedValue = nested.slice(nestedColon + 1).trim();
      if (nestedValue) {
        source[nestedKey] = stripYamlString(nestedValue) as never;
      }
    }
  }
  return source;
}

function sourceFrontmatterLines(source: CaptureSource): string[] {
  const lines = ["source:"];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === "") {
      continue;
    }
    lines.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  return lines;
}

export function mergeCaptureFrontmatter(input: {
  content: string;
  source: CaptureSource;
  tags: string[];
  title?: string;
}): string {
  const { lines, body, hasFrontmatter } = splitFrontmatter(input.content);
  const nextLines: string[] = [];
  let skippingSource = false;
  let hasTags = false;
  let hasTitle = false;

  for (const line of lines) {
    if (skippingSource) {
      if (line.startsWith("  ") || line.trim() === "") {
        continue;
      }
      skippingSource = false;
    }

    if (line.startsWith("source:")) {
      skippingSource = true;
      continue;
    }
    if (line.startsWith("tags:")) {
      hasTags = true;
    }
    if (line.startsWith("title:")) {
      hasTitle = true;
    }
    nextLines.push(line);
  }

  if (input.title && !hasTitle) {
    nextLines.unshift(`title: ${JSON.stringify(input.title)}`);
  }
  if (input.tags.length > 0 && !hasTags) {
    nextLines.push("tags:");
    for (const tag of input.tags) {
      nextLines.push(`  - ${JSON.stringify(tag)}`);
    }
  }
  nextLines.push(...sourceFrontmatterLines(input.source));

  const normalizedBody = hasFrontmatter ? body : input.content;
  return (
    `---\n${nextLines.join("\n")}\n---\n\n${normalizedBody.trimStart()}`.trimEnd() +
    "\n"
  );
}

function buildCaptureContent(input: {
  captureInput: CaptureInput;
  title: string;
  tags: string[];
  source: CaptureSource;
}): { content: string; body: string; tags: string[] } {
  const presetId = input.captureInput.presetId;
  if (presetId && !getNotePreset(presetId)) {
    throw new Error(`Unknown presetId: ${presetId}`);
  }

  const body = input.captureInput.content;
  if (body !== undefined) {
    validateTextContent(body);
  }
  if (!presetId && (!body || body.trim().length === 0)) {
    throw new Error(
      "Capture content is required unless presetId scaffolds it."
    );
  }

  const resolvedPreset = resolveNotePreset({
    presetId,
    title: input.title,
    tags: input.tags,
    frontmatter: {
      source: [],
    },
    body,
  });
  const rawContent =
    resolvedPreset?.content ?? body ?? `# ${input.title || "Untitled"}\n`;
  const content = mergeCaptureFrontmatter({
    content: rawContent,
    source: input.source,
    tags: resolvedPreset?.tags ?? input.tags,
    title: input.title,
  });
  return {
    content,
    body: body ?? resolvedPreset?.body ?? "",
    tags: resolvedPreset?.tags ?? input.tags,
  };
}

export function planCapture(options: PlanCaptureOptions): CapturePlan {
  const capturedAt = (options.now ?? new Date()).toISOString();
  const source = normalizeSource(options.input.source, capturedAt);
  const title = chooseTitle(options.input, "Captured Note");
  const tags = normalizeCaptureTags(options.input.tags);
  const {
    content,
    body,
    tags: contentTags,
  } = buildCaptureContent({
    captureInput: options.input,
    title,
    tags,
    source,
  });
  const contentHash = hashCaptureContent(body || content);
  const generatedRelPath =
    !options.input.relPath && !options.input.folderPath && !options.input.title
      ? generatedCaptureRelPath(source.capturedAt, contentHash)
      : undefined;
  const existing = buildExistingSet(
    options.existingRelPaths,
    options.diskRelPaths
  );
  const collisionPolicy =
    options.input.collisionPolicy ??
    (generatedRelPath ? "open_existing" : "error");
  const createPlan = resolveNoteCreatePlan(
    {
      collection: options.input.collection,
      relPath: options.input.relPath ?? generatedRelPath,
      title,
      folderPath: options.input.folderPath,
      collisionPolicy,
    },
    existing
  );

  return {
    collection: options.input.collection,
    relPath: createPlan.relPath,
    filename: createPlan.filename,
    content,
    body,
    contentHash,
    title,
    tags: contentTags,
    source,
    openedExisting: createPlan.openedExisting,
    createdWithSuffix: createPlan.createdWithSuffix,
    collisionPolicy,
    collisionPolicyResult: createPlan.openedExisting
      ? "opened_existing"
      : createPlan.createdWithSuffix
        ? "created_with_suffix"
        : "created",
  };
}

export function buildCaptureReceipt(input: {
  plan: CapturePlan;
  absPath?: string;
  docid?: string;
  sync?: CaptureIndexStatus;
  embed?: CaptureIndexStatus;
  overwritten?: boolean;
  serverInstanceId?: string;
}): CaptureReceipt {
  const overwritten = input.overwritten ?? false;
  return {
    uri: buildUri(input.plan.collection, input.plan.relPath),
    docid: input.docid,
    collection: input.plan.collection,
    relPath: input.plan.relPath,
    absPath: input.absPath,
    created: !input.plan.openedExisting && !overwritten,
    openedExisting: input.plan.openedExisting,
    createdWithSuffix: input.plan.createdWithSuffix,
    overwritten,
    contentHash: input.plan.contentHash,
    source: input.plan.source,
    tags: input.plan.tags,
    sync: input.sync ?? { status: "not_requested" },
    embed: input.embed ?? {
      status: "not_requested",
      reason: "Capture does not embed automatically.",
    },
    collisionPolicyResult: overwritten
      ? "overwritten"
      : input.plan.collisionPolicyResult,
    serverInstanceId: input.serverInstanceId,
  };
}

export function buildLegacyEditableCopySource(input: {
  docid: string;
  uri: string;
  mime: string;
  ext: string;
  capturedAt?: string;
}): CaptureSource {
  return {
    kind: "file",
    docid: input.docid,
    uri: input.uri,
    mime: input.mime,
    ext: input.ext,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
}

export function serializeCaptureReceipt(receipt: CaptureReceipt): string {
  return JSON.stringify(receipt, null, 2);
}
