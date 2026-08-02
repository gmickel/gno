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
