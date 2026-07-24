import { z } from "zod";

import { canonicalize } from "../converters/canonicalize";
import {
  BROWSER_CLIP_MAX_BYTES,
  BROWSER_CLIP_SCHEMA_VERSION,
  BROWSER_CLIP_WARNING_CODES,
  browserClipHttpUrlSchema,
  findDisallowedBrowserClipControlPath,
  type BrowserClipProvenance,
  type BrowserClipWarningCode,
} from "./browser-clip-provenance";
import {
  hashCaptureContent,
  type CaptureInput,
  type CaptureSource,
} from "./capture";

export {
  BROWSER_CLIP_MAX_BYTES,
  BROWSER_CLIP_SCHEMA_VERSION,
} from "./browser-clip-provenance";
export type {
  BrowserClipProvenance,
  BrowserClipWarningCode,
} from "./browser-clip-provenance";

const sha256 = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, stableJsonValue(child)])
    );
  }
  return value;
};

const stableJson = (value: unknown): string =>
  JSON.stringify(stableJsonValue(value));

const strictDateTime = z.string().datetime({ offset: true });
const strictPublishedDate = z
  .union([z.string().date(), z.string().datetime({ offset: true })])
  .nullable();

const safeInlineText = z.string().min(1).max(32_768);
const inlineNodeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: safeInlineText }).strict(),
  z
    .object({
      type: z.literal("link"),
      text: safeInlineText,
      href: browserClipHttpUrlSchema,
    })
    .strict(),
]);
const inlineContentSchema = z.array(inlineNodeSchema).min(1).max(256);

const readerBlockSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("paragraph"), content: inlineContentSchema })
    .strict(),
  z
    .object({
      type: z.literal("heading"),
      level: z.number().int().min(1).max(6),
      content: inlineContentSchema,
    })
    .strict(),
  z.object({ type: z.literal("quote"), content: inlineContentSchema }).strict(),
  z
    .object({
      type: z.literal("list"),
      ordered: z.boolean(),
      items: z.array(inlineContentSchema).min(1).max(256),
    })
    .strict(),
  z
    .object({
      type: z.literal("code"),
      language: z
        .string()
        .regex(/^[A-Za-z0-9_+-]{1,32}$/)
        .nullable(),
      text: z.string().max(131_072),
    })
    .strict(),
  z.object({ type: z.literal("horizontal_rule") }).strict(),
]);

const commonPayload = z
  .object({
    schemaVersion: z.literal(BROWSER_CLIP_SCHEMA_VERSION),
    sourceUrl: browserClipHttpUrlSchema,
    canonicalUrl: browserClipHttpUrlSchema.nullable(),
    title: z.string().min(1).max(2048),
    author: z.string().max(1024).nullable(),
    site: z.string().max(1024).nullable(),
    publishedAt: strictPublishedDate,
    observedAt: strictDateTime,
    browser: z
      .object({
        name: z.string().min(1).max(128),
        version: z.string().max(128).nullable(),
        platform: z.string().max(128).nullable(),
      })
      .strict(),
    extraction: z
      .object({
        visibility: z.literal("user_visible"),
        authenticated: z.boolean(),
        extractorVersion: z.string().min(1).max(128),
        warnings: z.array(z.enum(BROWSER_CLIP_WARNING_CODES)).max(16),
      })
      .strict(),
    destination: z
      .object({
        collection: z.string().min(1).max(128),
        relPath: z.string().min(1).max(2048).nullable(),
        folderPath: z.string().min(1).max(2048).nullable(),
        collisionPolicy: z.enum([
          "error",
          "open_existing",
          "create_with_suffix",
        ]),
      })
      .strict(),
    tags: z.array(z.string().min(1).max(256)).max(128),
    note: z.string().max(32_768).nullable(),
  })
  .strict();

const selectionPayload = commonPayload
  .extend({
    mode: z.literal("selection"),
    selection: z
      .object({
        exactText: z.string().min(1).max(BROWSER_CLIP_MAX_BYTES),
        editedMarkdown: z.string().max(BROWSER_CLIP_MAX_BYTES).nullable(),
      })
      .strict(),
  })
  .strict();

const readerPayload = commonPayload
  .extend({
    mode: z.literal("reader"),
    reader: z
      .object({
        blocks: z.array(readerBlockSchema).min(1).max(4096),
        editedMarkdown: z.string().max(BROWSER_CLIP_MAX_BYTES).nullable(),
      })
      .strict(),
  })
  .strict();

export const browserClipPayloadSchema = z
  .discriminatedUnion("mode", [selectionPayload, readerPayload])
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
      new TextEncoder().encode(stableJson(value)).byteLength >
      BROWSER_CLIP_MAX_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: "Browser clip payload is too large",
      });
    }
    if (
      new Set(value.extraction.warnings).size !==
      value.extraction.warnings.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Warning codes must be unique",
      });
    }
    if (
      value.destination.relPath !== null &&
      value.destination.folderPath !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "Use relPath or folderPath, not both",
        path: ["destination"],
      });
    }
  });

export type BrowserClipPayload = z.infer<typeof browserClipPayloadSchema>;
export type BrowserClipBlock = z.infer<typeof readerBlockSchema>;

export interface PreparedBrowserClip {
  payload: BrowserClipPayload;
  captureInput: CaptureInput;
  provenance: BrowserClipProvenance;
  preview: {
    body: string;
    digest: string;
    source: CaptureSource;
    destination: BrowserClipPayload["destination"];
    tags: string[];
  };
}

const normalizeUrl = (value: string): string => {
  const url = new URL(value);
  url.hash = "";
  url.searchParams.sort();
  return url.toString();
};

const normalizePublishedAt = (value: string | null): string | null => {
  if (value === null || /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(value).toISOString();
};

const escapeInline = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([*_[\]~`])/g, "\\$1");

const normalizeLink = (value: string): string =>
  normalizeUrl(value).replaceAll("(", "%28").replaceAll(")", "%29");

const renderInline = (content: z.infer<typeof inlineContentSchema>): string =>
  content
    .map((node) =>
      node.type === "text"
        ? escapeInline(node.text)
        : `[${escapeInline(node.text)}](${normalizeLink(node.href)})`
    )
    .join("");

const codeFence = (text: string): string => {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length)
  );
  return "`".repeat(Math.max(3, longest + 1));
};

export const renderBrowserClipReader = (
  blocks: readonly BrowserClipBlock[]
): string =>
  canonicalize(
    blocks
      .map((block) => {
        switch (block.type) {
          case "paragraph":
            return renderInline(block.content);
          case "heading":
            return `${"#".repeat(block.level)} ${renderInline(block.content)}`;
          case "quote":
            return renderInline(block.content)
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n");
          case "list":
            return block.items
              .map(
                (item, index) =>
                  `${block.ordered ? `${index + 1}.` : "-"} ${renderInline(item)}`
              )
              .join("\n");
          case "code": {
            const fence = codeFence(block.text);
            return `${fence}${block.language ?? ""}\n${block.text}\n${fence}`;
          }
          case "horizontal_rule":
            return "---";
        }
      })
      .join("\n\n")
  );

const INLINE_MARKDOWN_LINK = /(?<!!)\[[^\]\r\n]*\]\(([^()\s]+)\)/gu;
const REFERENCE_LINK = /\[[^\]\r\n]*\]\s*\[[^\]\r\n]*\]/u;
const REFERENCE_DEFINITION = /^[ \t]{0,3}\[[^\]\r\n]+\]:/mu;

const assertSafeEditedMarkdown = (markdown: string): void => {
  if (markdown.includes("<") || markdown.includes(">")) {
    throw new Error(
      "Edited clip Markdown cannot contain HTML, comments, or autolinks."
    );
  }
  if (markdown.includes("![")) {
    throw new Error("Edited clip Markdown cannot contain images.");
  }
  if (REFERENCE_LINK.test(markdown) || REFERENCE_DEFINITION.test(markdown)) {
    throw new Error("Edited clip Markdown cannot contain reference links.");
  }
  const unmatchedInlineSyntax = markdown.replace(
    INLINE_MARKDOWN_LINK,
    (_link, destination: string) => {
      browserClipHttpUrlSchema.parse(destination);
      return "";
    }
  );
  if (unmatchedInlineSyntax.includes("](")) {
    throw new Error(
      "Edited clip Markdown links must use a simple absolute HTTP(S) destination."
    );
  }
};

const notePrefix = (note: string | null): string => {
  const trimmed = note?.trim();
  if (!trimmed) return "";
  return `> **Clip note:** ${escapeInline(trimmed).replaceAll("\n", "\n> ")}\n\n`;
};

const dedupeWarnings = (
  values: readonly BrowserClipWarningCode[]
): BrowserClipWarningCode[] => [...new Set(values)].sort();

export const prepareBrowserClip = (
  input: unknown,
  options: { now?: Date } = {}
): PreparedBrowserClip => {
  const payload = browserClipPayloadSchema.parse(input);
  const capturedAt = (options.now ?? new Date()).toISOString();
  const sourceUrl = normalizeUrl(payload.sourceUrl);
  const canonicalUrl =
    payload.canonicalUrl === null ? null : normalizeUrl(payload.canonicalUrl);
  const extracted =
    payload.mode === "selection"
      ? payload.selection.exactText
      : stableJson(payload.reader.blocks);
  const edited =
    payload.mode === "selection"
      ? payload.selection.editedMarkdown
      : payload.reader.editedMarkdown;
  if (edited !== null) assertSafeEditedMarkdown(edited);
  const uneditedBody =
    payload.mode === "selection"
      ? escapeInline(payload.selection.exactText)
      : renderBrowserClipReader(payload.reader.blocks);
  const body = canonicalize(
    `${notePrefix(payload.note)}${edited ?? uneditedBody}`
  );
  const extractionHash = sha256(extracted);
  const finalBodyHash = hashCaptureContent(body);
  const clipIdentity = sha256(
    stableJson({
      canonicalUrl,
      extractionHash,
      finalBodyHash,
      mode: payload.mode,
      schemaVersion: payload.schemaVersion,
      sourceUrl,
    })
  );
  const warnings: BrowserClipWarningCode[] = [...payload.extraction.warnings];
  if (payload.extraction.authenticated)
    warnings.push("authenticated_visible_content");
  if (canonicalUrl !== null && canonicalUrl !== sourceUrl) {
    warnings.push("canonical_url_differs");
  }
  if (edited !== null) warnings.push("edited_content");
  if (extracted.includes("\r")) warnings.push("line_endings_normalized");
  if (extracted.normalize("NFC") !== extracted)
    warnings.push("unicode_normalized");
  const extractionWarnings = dedupeWarnings(warnings);
  const publishedAt = normalizePublishedAt(payload.publishedAt);
  const observedAt = new Date(payload.observedAt).toISOString();
  const exactSelection =
    payload.mode === "selection" ? payload.selection.exactText : null;
  const previewSource = {
    kind: "web",
    title: payload.title,
    url: sourceUrl,
    author: payload.author,
    observedAt,
    canonicalUrl,
    site: payload.site,
    publishedAt,
  };
  const previewProvenance = {
    schemaVersion: payload.schemaVersion,
    mode: payload.mode,
    sourceUrl,
    canonicalUrl,
    title: payload.title,
    author: payload.author,
    site: payload.site,
    publishedAt,
    observedAt,
    extractionHash,
    finalBodyHash,
    clipIdentity,
    exactSelection,
    extractionWarnings,
    browser: payload.browser,
  };
  const previewDigest = sha256(
    stableJson({
      body,
      destination: payload.destination,
      extraction: payload.extraction,
      provenance: previewProvenance,
      source: previewSource,
      tags: payload.tags,
    })
  );
  const provenance: BrowserClipProvenance = {
    schemaVersion: payload.schemaVersion,
    mode: payload.mode,
    sourceUrl,
    canonicalUrl,
    title: payload.title,
    author: payload.author,
    site: payload.site,
    publishedAt,
    observedAt,
    capturedAt,
    extractionHash,
    finalBodyHash,
    clipIdentity,
    previewDigest,
    exactSelection,
    extractionWarnings,
    browser: payload.browser,
  };
  const source: CaptureSource = {
    kind: "web",
    title: payload.title,
    url: sourceUrl,
    author: payload.author ?? undefined,
    observedAt: provenance.observedAt,
    capturedAt,
    canonicalUrl: canonicalUrl ?? undefined,
    site: payload.site ?? undefined,
    publishedAt: provenance.publishedAt ?? undefined,
    browserClip: provenance,
  };
  const captureInput: CaptureInput = {
    collection: payload.destination.collection,
    content: body,
    title: payload.title,
    relPath: payload.destination.relPath ?? undefined,
    folderPath: payload.destination.folderPath ?? undefined,
    collisionPolicy: payload.destination.collisionPolicy,
    tags: payload.tags,
    source,
  };
  return {
    payload,
    captureInput,
    provenance,
    preview: {
      body,
      digest: previewDigest,
      source,
      destination: payload.destination,
      tags: payload.tags,
    },
  };
};
