/**
 * Per-token classification for reference-safe file refactor planning.
 *
 * @module src/core/file-refactor-plan-classify
 */

import type {
  FileRefactorDestinationSpan,
  FileRefactorExaminedReference,
  FileRefactorReasonCode,
} from "./file-refactor-contract";
import type { FileRefactorPlannerDocument } from "./file-refactor-planner-types";
import type { FileRefactorCatalogDocument } from "./file-refactor-resolve";
import type { LinkInventoryToken } from "./link-inventory-types";

import {
  computeMarkdownReplacementDestination,
  computeWikiReplacementDestination,
  wikiDestinationUnchangedAcceptable,
} from "./file-refactor-destination";
import {
  normalizeInventoryMarkdownTarget,
  resolveMarkdownTarget,
  resolveWikiTarget,
} from "./file-refactor-resolve";

function spanFromToken(
  token: LinkInventoryToken,
  replacement: string
): FileRefactorDestinationSpan {
  return {
    coordinateSpace: "utf16_code_units",
    startOffset: token.destinationStart,
    endOffset: token.destinationEnd,
    originalDestination: token.originalDestination,
    replacementDestination: replacement,
  };
}

export function examinedFromToken(
  doc: FileRefactorPlannerDocument,
  token: LinkInventoryToken,
  overrides: Partial<FileRefactorExaminedReference> = {}
): FileRefactorExaminedReference {
  return {
    documentUri: doc.uri,
    documentRelPath: doc.relPath,
    kind: token.kind,
    classification: token.classification ?? "unchanged",
    reasonCode: token.reasonCode,
    originalDestination: token.originalDestination,
    proposedDestination:
      overrides.proposedDestination ?? token.originalDestination,
    startLine: token.startLine,
    startCol: token.startCol,
    endLine: token.endLine,
    endCol: token.endCol,
    ...overrides,
  };
}

function capabilityDenied(
  doc: FileRefactorPlannerDocument,
  token: LinkInventoryToken
): FileRefactorExaminedReference {
  return examinedFromToken(doc, token, {
    classification: "unsupported",
    reasonCode:
      doc.editableReason === "read_only_document"
        ? "read_only_document"
        : "capability_denied",
    proposedDestination: token.originalDestination,
    edit: undefined,
  });
}

/**
 * Classify one inventory token against the moved source. Returns null when the
 * token uniquely resolves elsewhere (not about this refactor).
 */
export function classifyResolvableToken(input: {
  token: LinkInventoryToken;
  doc: FileRefactorPlannerDocument;
  sourceUri: string;
  sourceRelPath: string;
  sourceTitle: string | null | undefined;
  targetRelPath: string;
  targetTitle: string | null | undefined;
  catalog: FileRefactorCatalogDocument[];
}): FileRefactorExaminedReference | null {
  const { token, doc } = input;

  if (token.classification) {
    return examinedFromToken(doc, token, {
      classification: token.classification,
      reasonCode: token.reasonCode,
    });
  }

  if (token.targetCollection && token.targetCollection !== doc.collection) {
    return examinedFromToken(doc, token, {
      classification: "unsupported",
      reasonCode: "cross_collection_unsupported",
    });
  }

  if (token.kind === "wiki") {
    const resolution = resolveWikiTarget({
      targetRef: token.targetRef,
      targetCollection: token.targetCollection ?? doc.collection,
      sourceUri: input.sourceUri,
      catalog: input.catalog,
    });
    if (
      resolution.status === "elsewhere" ||
      resolution.status === "unresolved"
    ) {
      return null;
    }
    if (resolution.status === "ambiguous") {
      return examinedFromToken(doc, token, {
        classification: "ambiguous",
        reasonCode: resolution.reasonCode ?? "ambiguous_resolution",
      });
    }
    if (doc.editable === false) {
      return capabilityDenied(doc, token);
    }
    const replacement = computeWikiReplacementDestination({
      originalDestination: token.originalDestination,
      sourceRelPath: input.sourceRelPath,
      sourceTitle: input.sourceTitle,
      targetRelPath: input.targetRelPath,
      targetTitle: input.targetTitle,
    });
    if (
      wikiDestinationUnchangedAcceptable({
        originalDestination: token.originalDestination,
        replacementDestination: replacement,
      })
    ) {
      return examinedFromToken(doc, token, {
        classification: "unchanged",
        reasonCode: "destination_unchanged",
        proposedDestination: token.originalDestination,
      });
    }
    return examinedFromToken(doc, token, {
      classification: "rewriteable",
      proposedDestination: replacement,
      edit: spanFromToken(token, replacement),
    });
  }

  const normalized = normalizeInventoryMarkdownTarget(
    token.targetRef,
    doc.relPath
  );
  if (!normalized) {
    return examinedFromToken(doc, token, {
      classification: "invalid",
      reasonCode: "unsafe_target",
    });
  }
  const resolution = resolveMarkdownTarget({
    targetRefNorm: normalized,
    targetCollection: doc.collection,
    sourceUri: input.sourceUri,
    catalog: input.catalog,
  });
  if (resolution.status === "elsewhere" || resolution.status === "unresolved") {
    return null;
  }
  if (resolution.status === "ambiguous") {
    return examinedFromToken(doc, token, {
      classification: "ambiguous",
      reasonCode: resolution.reasonCode ?? "ambiguous_resolution",
    });
  }
  if (doc.editable === false) {
    return capabilityDenied(doc, token);
  }

  const replacement = computeMarkdownReplacementDestination({
    token,
    referringRelPath: doc.relPath,
    targetRelPath: input.targetRelPath,
  });
  const reasonCode: FileRefactorReasonCode =
    token.kind === "markdown_definition"
      ? "reference_definition_site"
      : "relative_path_recalculated";

  if (replacement === token.originalDestination) {
    return examinedFromToken(doc, token, {
      classification: "unchanged",
      reasonCode: "destination_unchanged",
      proposedDestination: token.originalDestination,
    });
  }

  return examinedFromToken(doc, token, {
    classification: "rewriteable",
    reasonCode,
    proposedDestination: replacement,
    edit: spanFromToken(token, replacement),
  });
}
