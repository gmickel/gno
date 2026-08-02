/**
 * Durable SectionTargetV1 types, bounds, and creation.
 * Private helper module — import public API from `./sections`.
 *
 * @module src/core/section-target
 */

import {
  extractSectionRecords,
  lineStartOffsets,
  type SectionRecord,
} from "./section-parse";

/** Versioned, bounded, content-derived section locator (v1). */
export interface SectionTargetV1 {
  schemaVersion: "1";
  document: {
    uri: string;
  };
  /** Human-readable heading anchor at capture time. */
  anchor: string;
  /** NFC-normalized heading ancestry including the section title. */
  headingPath: string[];
  /** 1-based occurrence among sections with the same headingPath. */
  occurrence: number;
  quote: {
    exact: string;
    prefix: string;
    suffix: string;
  };
  /** SHA-256 hex fingerprint of the full source document content. */
  sourceFingerprint: string;
  /** Line/offset hints only — never identity. */
  hints: {
    line: number;
    startOffset: number;
    endOffset: number;
  };
}

export const SECTION_TARGET_SCHEMA_VERSION = "1" as const;

/**
 * Hard bounds so targets never embed full section bodies and remain
 * schema-faithful. Identity fields (uri/anchor/headingPath) are never
 * truncated — creation fails closed when they cannot fit.
 */
export const SECTION_TARGET_BOUNDS = {
  exactMaxChars: 96,
  prefixMaxChars: 32,
  suffixMaxChars: 32,
  uriMaxChars: 1024,
  anchorMaxChars: 512,
  headingPathItemMaxChars: 512,
  headingPathMaxItems: 6,
  maxSerializedBytes: 2048,
} as const;

const UTF8 = new TextEncoder();

/** Structural section record with bounded quote evidence. */
export interface QuotedSectionRecord extends SectionRecord {
  quote: {
    exact: string;
    prefix: string;
    suffix: string;
  };
  quoteStartOffset: number;
  quoteEndOffset: number;
}

const clipStart = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : value.slice(0, maxChars);

const clipEnd = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : value.slice(value.length - maxChars);

const bytesOf = (value: string): number => UTF8.encode(value).byteLength;

/** SHA-256 hex digest via Web Crypto (browser- and Bun-safe). */
export async function fingerprintSourceContent(
  content: string
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", UTF8.encode(content))
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const chooseQuoteRange = (
  content: string,
  recordTitleStart: number,
  recordTitleEnd: number,
  bodyStartOffset: number,
  bodyEndOffset: number
): { start: number; end: number } => {
  const body = content.slice(bodyStartOffset, bodyEndOffset);
  const trimmedLead = body.match(/^\s*/)?.[0]?.length ?? 0;
  const trimmedTrail = body.match(/\s*$/)?.[0]?.length ?? 0;
  const bodyContentStart = bodyStartOffset + trimmedLead;
  const bodyContentEnd = Math.max(
    bodyContentStart,
    bodyEndOffset - trimmedTrail
  );
  if (bodyContentStart < bodyContentEnd) {
    const exact = clipStart(
      content.slice(bodyContentStart, bodyContentEnd),
      SECTION_TARGET_BOUNDS.exactMaxChars
    );
    if (exact.length > 0) {
      return {
        start: bodyContentStart,
        end: bodyContentStart + exact.length,
      };
    }
  }
  return { start: recordTitleStart, end: recordTitleEnd };
};

/**
 * Prefer local context so heading renames / insertions do not poison prefix
 * evidence. Falls back to a short global clip only when local context is empty.
 */
const buildBoundedQuote = (
  content: string,
  exactStart: number,
  exactEnd: number,
  localPrefixFloor: number
): { exact: string; prefix: string; suffix: string } => {
  const exact = clipStart(
    content.slice(exactStart, exactEnd),
    SECTION_TARGET_BOUNDS.exactMaxChars
  );
  const boundedEnd = exactStart + exact.length;
  const localPrefix = content.slice(localPrefixFloor, exactStart);
  const prefixSource =
    localPrefix.length > 0 ? localPrefix : content.slice(0, exactStart);
  return {
    exact,
    prefix: clipEnd(prefixSource, SECTION_TARGET_BOUNDS.prefixMaxChars),
    suffix: clipStart(
      content.slice(boundedEnd),
      SECTION_TARGET_BOUNDS.suffixMaxChars
    ),
  };
};

/** Attach bounded quote evidence to structural section records. */
export const withQuotes = (
  content: string,
  records: readonly SectionRecord[]
): QuotedSectionRecord[] => {
  const starts = lineStartOffsets(content);
  return records.map((record) => {
    const bodyStartOffset = starts[record.section.line] ?? content.length;
    const bodyEndOffset =
      record.endLine >= starts.length
        ? content.length
        : (starts[record.endLine] ?? content.length);
    const quoteRange = chooseQuoteRange(
      content,
      record.titleStartOffset,
      record.titleEndOffset,
      bodyStartOffset,
      bodyEndOffset
    );
    // Keep prefix local to the gap after the heading title (or markers before
    // a title-only quote) so renames do not poison quote recovery.
    const prefixFloor =
      quoteRange.start >= record.titleEndOffset
        ? record.titleEndOffset
        : (starts[record.section.line - 1] ?? record.titleStartOffset);
    return {
      ...record,
      quoteStartOffset: quoteRange.start,
      quoteEndOffset: quoteRange.end,
      quote: buildBoundedQuote(
        content,
        quoteRange.start,
        quoteRange.end,
        prefixFloor
      ),
    };
  });
};

/**
 * True when every identity/quote field and the UTF-8 JSON encoding satisfy
 * runtime bounds. Identity fields must be present faithfully — never truncated.
 */
export const isBoundedSectionTarget = (target: SectionTargetV1): boolean => {
  const { uri } = target.document;
  if (
    uri.length < 1 ||
    uri.length > SECTION_TARGET_BOUNDS.uriMaxChars ||
    target.anchor.length < 1 ||
    target.anchor.length > SECTION_TARGET_BOUNDS.anchorMaxChars ||
    target.headingPath.length < 1 ||
    target.headingPath.length > SECTION_TARGET_BOUNDS.headingPathMaxItems ||
    target.headingPath.some(
      (item) =>
        item.length < 1 ||
        item.length > SECTION_TARGET_BOUNDS.headingPathItemMaxChars
    ) ||
    target.quote.exact.length > SECTION_TARGET_BOUNDS.exactMaxChars ||
    target.quote.prefix.length > SECTION_TARGET_BOUNDS.prefixMaxChars ||
    target.quote.suffix.length > SECTION_TARGET_BOUNDS.suffixMaxChars
  ) {
    return false;
  }
  return (
    bytesOf(JSON.stringify(target)) <= SECTION_TARGET_BOUNDS.maxSerializedBytes
  );
};

export interface CreateSectionTargetInput {
  content: string;
  uri: string;
  /** Capture by current readable anchor, or by 1-based heading line. */
  anchor?: string;
  line?: number;
}

/**
 * Create a bounded SectionTargetV1 for a heading in `content`.
 * Returns null when the section cannot be found, or when a faithful
 * bounded target cannot be produced (oversized uri/anchor/path/serialized).
 */
export async function createSectionTarget(
  input: CreateSectionTargetInput
): Promise<SectionTargetV1 | null> {
  const records = withQuotes(
    input.content,
    extractSectionRecords(input.content)
  );
  const record =
    input.anchor !== undefined
      ? records.find((entry) => entry.section.anchor === input.anchor)
      : input.line !== undefined
        ? records.find((entry) => entry.section.line === input.line)
        : undefined;
  if (!record) return null;

  const sourceFingerprint = await fingerprintSourceContent(input.content);
  const target: SectionTargetV1 = {
    schemaVersion: SECTION_TARGET_SCHEMA_VERSION,
    document: { uri: input.uri },
    anchor: record.section.anchor,
    headingPath: [...record.headingPath],
    occurrence: record.occurrence,
    quote: { ...record.quote },
    sourceFingerprint,
    hints: {
      line: record.section.line,
      startOffset: record.quoteStartOffset,
      endOffset: record.quoteEndOffset,
    },
  };

  // Fail closed: never truncate identity-bearing uri/anchor/path.
  if (!isBoundedSectionTarget(target)) return null;
  return target;
}
