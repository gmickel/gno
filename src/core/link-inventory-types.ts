/**
 * Shared inventory token types and caps for reference-safe refactors.
 *
 * @module src/core/link-inventory-types
 */

import type {
  FileRefactorReasonCode,
  FileRefactorReferenceClassification,
  FileRefactorReferenceKind,
} from "./file-refactor-contract";
import type { LinkEncodingStyle } from "./link-destination-parse";

/** Hard caps — callers must fail closed when truncated. */
export const LINK_INVENTORY_CAPS = {
  maxContentChars: 1_000_000,
  maxTokensPerDocument: 2_000,
} as const;

export interface LinkInventoryToken {
  kind: FileRefactorReferenceKind;
  classification?: FileRefactorReferenceClassification;
  reasonCode?: FileRefactorReasonCode;
  raw: string;
  originalDestination: string;
  destinationStart: number;
  destinationEnd: number;
  startOffset: number;
  endOffset: number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  targetRef: string;
  targetAnchor?: string;
  targetCollection?: string;
  targetQuery?: string;
  hadLeadingDotSlash: boolean;
  encodingStyle: LinkEncodingStyle;
}

export interface LinkInventoryResult {
  tokens: LinkInventoryToken[];
  truncated: boolean;
  /** True when destination spans overlap after inventory. */
  overlapping: boolean;
}
