/**
 * Readable section deep links and optional citation-safe selectors.
 *
 * Copy-link stays human-readable (`#anchor` only). Citation links add a
 * bounded, versioned `st` query param for conservative recovery.
 *
 * @module src/serve/public/lib/section-links
 */

import {
  createSectionTarget,
  decodeSectionTargetLinkParam,
  encodeSectionTargetLinkParam,
  isNavigableSectionResolution,
  resolveSectionTarget,
  SECTION_TARGET_LINK_PARAM,
  type SectionResolutionStatus,
  type SectionTargetV1,
} from "../../../core/sections";
import { buildDocDeepLink, type DocumentDeepLinkTarget } from "./deep-links";

export interface SectionLinkTarget extends DocumentDeepLinkTarget {
  /** Readable heading anchor (HTML id). */
  anchor: string;
}

export type SectionLinkNoticeKind =
  | "copied_link"
  | "copied_citation"
  | "citation_unavailable"
  | "clipboard_unavailable"
  | SectionResolutionStatus
  | "invalid_citation";

/** Ephemeral, content-free status copy for outline/rail feedback. */
export const SECTION_LINK_NOTICE_COPY: Record<SectionLinkNoticeKind, string> = {
  copied_link: "Copied section link",
  copied_citation: "Copied citation link",
  citation_unavailable: "Citation unavailable for this section",
  clipboard_unavailable: "Could not copy link",
  exact: "Exact section match",
  recovered: "Section recovered",
  ambiguous: "Ambiguous section link — not navigating",
  stale: "Stale section link — not navigating",
  missing: "Section link not found — not navigating",
  invalid_citation: "Invalid section citation — not navigating",
};

/** Absolute readable section URL for human sharing (no durable selector). */
export function buildReadableSectionUrl(
  origin: string,
  target: SectionLinkTarget
): string {
  const path = `${buildDocDeepLink({
    uri: target.uri,
    view: target.view ?? "rendered",
  })}#${target.anchor}`;
  return `${origin}${path}`;
}

/**
 * Absolute citation URL: readable `#anchor` plus bounded `st` selector.
 * Returns null when a faithful bounded encoding cannot be produced.
 */
export function buildCitationSectionUrl(
  origin: string,
  target: SectionLinkTarget,
  sectionTarget: SectionTargetV1
): string | null {
  const encoded = encodeSectionTargetLinkParam(sectionTarget);
  if (!encoded) {
    return null;
  }
  const params = new URLSearchParams({ uri: target.uri });
  params.set("view", target.view ?? "rendered");
  params.set(SECTION_TARGET_LINK_PARAM, encoded);
  return `${origin}/doc?${params.toString()}#${target.anchor}`;
}

/** Read the raw `st` query value from a location search string. */
export function readSectionTargetLinkParam(search: string): string | null {
  const value = new URLSearchParams(search).get(SECTION_TARGET_LINK_PARAM);
  return value && value.length > 0 ? value : null;
}

/** Strip the additive `st` param while preserving other query fields. */
export function stripSectionTargetLinkParam(search: string): string {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search
  );
  params.delete(SECTION_TARGET_LINK_PARAM);
  const serialized = params.toString();
  return serialized.length > 0 ? `?${serialized}` : "";
}

export interface ResolveSectionLinkInput {
  content: string;
  uri: string;
  /** Raw `st` query value. */
  encodedTarget: string | null;
  /** Readable hash without leading `#`. */
  hashAnchor: string;
}

export interface ResolveSectionLinkResult {
  /** When true, hash-only scroll must not run. */
  blockHashNavigation: boolean;
  /** Anchor to scroll to when navigable. */
  navigateAnchor: string | null;
  notice: SectionLinkNoticeKind | null;
  /** Drop `st` from the address bar after a successful recovery. */
  cleanCitationParam: boolean;
}

/**
 * Resolve an optional durable selector against current document content.
 * Readable `#anchor`-only links keep legacy behavior (no block).
 */
export async function resolveSectionLinkNavigation(
  input: ResolveSectionLinkInput
): Promise<ResolveSectionLinkResult> {
  if (!input.encodedTarget) {
    return {
      blockHashNavigation: false,
      navigateAnchor: input.hashAnchor || null,
      notice: null,
      cleanCitationParam: false,
    };
  }

  const target = decodeSectionTargetLinkParam(input.encodedTarget);
  if (!target) {
    return {
      blockHashNavigation: true,
      navigateAnchor: null,
      notice: "invalid_citation",
      cleanCitationParam: false,
    };
  }

  const resolution = await resolveSectionTarget({
    content: input.content,
    target,
    uri: input.uri,
  });

  if (isNavigableSectionResolution(resolution)) {
    return {
      blockHashNavigation: false,
      navigateAnchor: resolution.section.anchor,
      notice: resolution.status,
      cleanCitationParam: true,
    };
  }

  return {
    blockHashNavigation: true,
    navigateAnchor: null,
    notice: resolution.status,
    cleanCitationParam: false,
  };
}

/** Create a citation URL for an outline section using shared core create. */
export async function createCitationSectionUrl(input: {
  origin: string;
  uri: string;
  content: string;
  anchor: string;
  view?: "rendered" | "source";
}): Promise<string | null> {
  const target = await createSectionTarget({
    content: input.content,
    uri: input.uri,
    anchor: input.anchor,
  });
  if (!target) {
    return null;
  }
  return buildCitationSectionUrl(
    input.origin,
    {
      uri: input.uri,
      view: input.view ?? "rendered",
      anchor: input.anchor,
    },
    target
  );
}
