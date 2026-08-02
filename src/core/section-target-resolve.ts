/**
 * Conservative SectionTargetV1 resolution.
 * Private helper module — import public API from `./sections`.
 *
 * @module src/core/section-target-resolve
 */

import {
  extractSectionRecords,
  lineStartOffsets,
  normalizeHeadingTitle,
  type DocumentSection,
  type SectionRecord,
} from "./section-parse";
import {
  fingerprintSourceContent,
  withQuotes,
  type QuotedSectionRecord,
  type SectionTargetV1,
} from "./section-target";

export type SectionResolutionStatus =
  | "exact"
  | "recovered"
  | "ambiguous"
  | "stale"
  | "missing";

export interface SectionResolutionCandidate {
  anchor: string;
  line: number;
  title: string;
  headingPath: string[];
  occurrence: number;
}

export interface SectionResolution {
  status: SectionResolutionStatus;
  target: SectionTargetV1;
  currentFingerprint: string;
  /** Present only when status is exact or recovered (navigable). */
  section?: DocumentSection & { endLine: number };
  /** Safe candidate list when status is ambiguous. */
  candidates?: SectionResolutionCandidate[];
  reason?: string;
}

const pathsEqual = (
  left: readonly string[],
  right: readonly string[]
): boolean =>
  left.length === right.length &&
  left.every(
    (value, index) => value === normalizeHeadingTitle(right[index] ?? "")
  );

const sectionSpan = (
  content: string,
  record: SectionRecord,
  starts: readonly number[]
): { start: number; end: number } => {
  const start = record.titleStartOffset;
  const end =
    record.endLine >= starts.length
      ? content.length
      : (starts[record.endLine] ?? content.length);
  return { start, end };
};

const quoteMatchesAt = (
  content: string,
  quote: SectionTargetV1["quote"]
): number[] => {
  if (!quote.exact) return [];
  const hits: number[] = [];
  let from = 0;
  while (from <= content.length) {
    const index = content.indexOf(quote.exact, from);
    if (index < 0) break;
    const prefixOk = content
      .slice(Math.max(0, index - quote.prefix.length), index)
      .endsWith(quote.prefix);
    const suffixOk = content
      .slice(index + quote.exact.length)
      .startsWith(quote.suffix);
    if (prefixOk && suffixOk) hits.push(index);
    from = index + 1;
  }
  return hits;
};

const innermostRecordAt = (
  records: readonly QuotedSectionRecord[],
  offset: number,
  content: string,
  starts: readonly number[]
): QuotedSectionRecord | null => {
  let best: QuotedSectionRecord | null = null;
  for (const record of records) {
    const span = sectionSpan(content, record, starts);
    if (offset < span.start || offset >= span.end) continue;
    if (
      !best ||
      record.titleStartOffset > best.titleStartOffset ||
      (record.titleStartOffset === best.titleStartOffset &&
        record.section.level > best.section.level)
    ) {
      best = record;
    }
  }
  return best;
};

const sectionContainsExact = (
  content: string,
  record: SectionRecord,
  exact: string,
  starts: readonly number[]
): boolean => {
  if (!exact) return false;
  const span = sectionSpan(content, record, starts);
  return content.slice(span.start, span.end).includes(exact);
};

const findQuoteMatches = (
  content: string,
  records: readonly QuotedSectionRecord[],
  quote: SectionTargetV1["quote"]
): QuotedSectionRecord[] => {
  const starts = lineStartOffsets(content);
  const matched = new Map<string, QuotedSectionRecord>();
  for (const offset of quoteMatchesAt(content, quote)) {
    const owner = innermostRecordAt(records, offset, content, starts);
    if (owner) matched.set(owner.section.anchor, owner);
  }
  // Also accept exact structural quote equality for the record itself.
  for (const record of records) {
    if (
      record.quote.exact === quote.exact &&
      record.quote.prefix === quote.prefix &&
      record.quote.suffix === quote.suffix
    ) {
      matched.set(record.section.anchor, record);
    }
  }
  return [...matched.values()];
};

const toCandidate = (
  record: QuotedSectionRecord
): SectionResolutionCandidate => ({
  anchor: record.section.anchor,
  line: record.section.line,
  title: record.section.title,
  headingPath: [...record.headingPath],
  occurrence: record.occurrence,
});

const navigable = (
  status: "exact" | "recovered",
  target: SectionTargetV1,
  currentFingerprint: string,
  record: QuotedSectionRecord
): SectionResolution => ({
  status,
  target,
  currentFingerprint,
  section: {
    ...record.section,
    endLine: record.endLine,
  },
});

export interface ResolveSectionTargetInput {
  content: string;
  target: SectionTargetV1;
  /** When set, a URI mismatch yields missing (wrong document). */
  uri?: string;
}

/**
 * Conservatively resolve a SectionTargetV1 against current document content.
 * Never silently navigates ambiguous or stale evidence.
 */
export async function resolveSectionTarget(
  input: ResolveSectionTargetInput
): Promise<SectionResolution> {
  const { target } = input;
  const currentFingerprint = await fingerprintSourceContent(input.content);

  if (input.uri !== undefined && input.uri !== target.document.uri) {
    return {
      status: "missing",
      target,
      currentFingerprint,
      reason: "document_uri_mismatch",
    };
  }

  const records = withQuotes(
    input.content,
    extractSectionRecords(input.content)
  );
  const sameRevision = currentFingerprint === target.sourceFingerprint;

  // Stage 1: same-revision structural match (anchor, else path+occurrence).
  if (sameRevision) {
    const byAnchor = records.filter(
      (entry) => entry.section.anchor === target.anchor
    );
    if (byAnchor.length === 1 && byAnchor[0]) {
      return navigable("exact", target, currentFingerprint, byAnchor[0]);
    }
    const byPath = records.filter(
      (entry) =>
        pathsEqual(entry.headingPath, target.headingPath) &&
        entry.occurrence === target.occurrence
    );
    if (byPath.length === 1 && byPath[0]) {
      return navigable("exact", target, currentFingerprint, byPath[0]);
    }
    if (byAnchor.length > 1 || byPath.length > 1) {
      return {
        status: "ambiguous",
        target,
        currentFingerprint,
        candidates: [...byAnchor, ...byPath]
          .filter(
            (entry, index, all) =>
              all.findIndex(
                (candidate) => candidate.section.anchor === entry.section.anchor
              ) === index
          )
          .map(toCandidate),
        reason: "same_revision_multiple_matches",
      };
    }
  }

  // Quote matches are computed once; non-unique quotes fail closed as ambiguous.
  const starts = lineStartOffsets(input.content);
  const quoteMatches = findQuoteMatches(input.content, records, target.quote);
  if (quoteMatches.length > 1) {
    return {
      status: "ambiguous",
      target,
      currentFingerprint,
      candidates: quoteMatches.map(toCandidate),
      reason: "quote_context_multiple_matches",
    };
  }

  // Stage 2: exact heading path/occurrence with quote evidence in-span.
  const pathMatches = records.filter(
    (entry) =>
      pathsEqual(entry.headingPath, target.headingPath) &&
      entry.occurrence === target.occurrence
  );
  if (pathMatches.length === 1 && pathMatches[0]) {
    const candidate = pathMatches[0];
    const quoteOk =
      sectionContainsExact(
        input.content,
        candidate,
        target.quote.exact,
        starts
      ) ||
      (quoteMatches.length === 1 &&
        quoteMatches[0]?.section.anchor === candidate.section.anchor);
    if (quoteOk) {
      return navigable(
        sameRevision ? "exact" : "recovered",
        target,
        currentFingerprint,
        candidate
      );
    }
  } else if (pathMatches.length > 1) {
    return {
      status: "ambiguous",
      target,
      currentFingerprint,
      candidates: pathMatches.map(toCandidate),
      reason: "path_occurrence_multiple_matches",
    };
  }

  // Stage 3: unique quote + context recovery.
  if (quoteMatches.length === 1 && quoteMatches[0]) {
    return navigable(
      sameRevision ? "exact" : "recovered",
      target,
      currentFingerprint,
      quoteMatches[0]
    );
  }

  // Fail closed: partial structural residue without unique recovery → stale;
  // no residue → missing.
  const pathResidue = records.some((entry) =>
    pathsEqual(entry.headingPath, target.headingPath)
  );
  const titleResidue = records.some(
    (entry) =>
      normalizeHeadingTitle(entry.section.title) ===
      normalizeHeadingTitle(target.headingPath.at(-1) ?? "")
  );
  const anchorResidue = records.some(
    (entry) => entry.section.anchor === target.anchor
  );

  if (!sameRevision && (pathResidue || titleResidue || anchorResidue)) {
    return {
      status: "stale",
      target,
      currentFingerprint,
      reason: "fingerprint_mismatch_without_unique_recovery",
      candidates: records
        .filter(
          (entry) =>
            pathsEqual(entry.headingPath, target.headingPath) ||
            entry.section.anchor === target.anchor ||
            normalizeHeadingTitle(entry.section.title) ===
              normalizeHeadingTitle(target.headingPath.at(-1) ?? "")
        )
        .map(toCandidate),
    };
  }

  return {
    status: "missing",
    target,
    currentFingerprint,
    reason: sameRevision
      ? "section_not_found_same_revision"
      : "section_not_found",
  };
}

/** True when the resolution may safely navigate to `section`. */
export function isNavigableSectionResolution(
  resolution: SectionResolution
): resolution is SectionResolution & {
  status: "exact" | "recovered";
  section: DocumentSection & { endLine: number };
} {
  return (
    (resolution.status === "exact" || resolution.status === "recovered") &&
    resolution.section !== undefined
  );
}
