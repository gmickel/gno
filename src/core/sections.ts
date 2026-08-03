/**
 * Shared section extraction, anchors, and durable section targets.
 *
 * Browser-safe (Web Crypto + standard string APIs only).
 *
 * @module src/core/sections
 */

export type { DocumentSection } from "./section-parse";
export {
  extractInclusiveLines,
  extractSections,
  headingForLine,
  slugifySectionTitle,
} from "./section-parse";

export type {
  CreateSectionTargetInput,
  SectionTargetV1,
} from "./section-target";
export {
  SECTION_TARGET_BOUNDS,
  SECTION_TARGET_SCHEMA_VERSION,
  createSectionTarget,
  fingerprintSourceContent,
  isBoundedSectionTarget,
} from "./section-target";

export type {
  ResolveSectionTargetInput,
  SectionResolution,
  SectionResolutionCandidate,
  SectionResolutionStatus,
} from "./section-target-resolve";
export {
  isNavigableSectionResolution,
  resolveSectionTarget,
} from "./section-target-resolve";

export type {
  SectionCitationV1,
  SectionResolutionDiagnostics,
  SectionTargetCreateResult,
  SectionTargetCreateSelector,
  SectionTargetResolveResult,
  TransportValidationResult,
} from "./section-target-transport";
export {
  CANONICAL_URI_EXCEEDS_TRANSPORT_BOUNDS,
  CITATION_EXCEEDS_TRANSPORT_BOUNDS,
  SECTION_TARGET_TRANSPORT_BOUNDS,
  isTransportBoundedCandidate,
  isTransportBoundedCanonicalUri,
  isTransportBoundedCitation,
  parseSectionTargetCreateSelector,
  parseSectionTargetResolveBody,
  parseSectionTargetV1,
  projectSectionTargetCreateResult,
  projectSectionTargetResolveResult,
} from "./section-target-transport";

export type { SectionTargetLinkDecodeFailure } from "./section-target-link";
export {
  SECTION_TARGET_LINK_MAX_ENCODED_CHARS,
  SECTION_TARGET_LINK_PARAM,
  SECTION_TARGET_LINK_VERSION,
  classifySectionTargetLinkDecodeFailure,
  decodeSectionTargetLinkParam,
  encodeSectionTargetLinkParam,
} from "./section-target-link";
