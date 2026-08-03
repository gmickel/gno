/**
 * Adversarial coverage for bounded section-target link encoding.
 */

import { describe, expect, test } from "bun:test";

import {
  classifySectionTargetLinkDecodeFailure,
  createSectionTarget,
  decodeSectionTargetLinkParam,
  encodeSectionTargetLinkParam,
  extractSections,
  isNavigableSectionResolution,
  resolveSectionTarget,
  SECTION_TARGET_LINK_MAX_ENCODED_CHARS,
  SECTION_TARGET_LINK_PARAM,
  SECTION_TARGET_LINK_VERSION,
  type SectionTargetV1,
} from "../../src/core/sections";
import {
  SECTION_AMBIGUOUS_CONTENT,
  SECTION_FIXTURE_CONTENT,
  SECTION_FIXTURE_URI,
  SECTION_MISSING_CONTENT,
  SECTION_RECOVERED_CONTENT,
  SECTION_STALE_CONTENT,
  captureFixtureTarget,
} from "../helpers/section-target-fixtures";

const SECRET_BODY = "PRIVATE_SECTION_BODY_SHOULD_NEVER_LEAK_IN_ERRORS";

describe("section target link encoding", () => {
  test("round-trips a bounded target under the versioned st param", async () => {
    const target = await captureFixtureTarget(SECTION_FIXTURE_CONTENT, {
      anchor: "setup",
    });
    const encoded = encodeSectionTargetLinkParam(target);
    expect(encoded).not.toBeNull();
    expect(encoded?.startsWith(`${SECTION_TARGET_LINK_VERSION}.`)).toBe(true);
    expect(encoded!.length).toBeLessThanOrEqual(
      SECTION_TARGET_LINK_MAX_ENCODED_CHARS
    );
    expect(decodeSectionTargetLinkParam(encoded!)).toEqual(target);
    expect(SECTION_TARGET_LINK_PARAM).toBe("st");
  });

  test("rejects oversized and malformed selectors without leaking bodies", () => {
    const oversized = `${SECTION_TARGET_LINK_VERSION}.${"a".repeat(SECTION_TARGET_LINK_MAX_ENCODED_CHARS)}`;
    expect(decodeSectionTargetLinkParam(oversized)).toBeNull();
    expect(classifySectionTargetLinkDecodeFailure(oversized)).toBe("oversized");

    const malformed = `${SECTION_TARGET_LINK_VERSION}.!!!${SECRET_BODY}`;
    expect(decodeSectionTargetLinkParam(malformed)).toBeNull();
    expect(classifySectionTargetLinkDecodeFailure(malformed)).toBe("malformed");
    expect(classifySectionTargetLinkDecodeFailure("2.abc")).toBe(
      "unsupported_version"
    );
    expect(classifySectionTargetLinkDecodeFailure("")).toBe("missing");

    // Failure classifiers stay content-free even when the input embeds secrets.
    expect(classifySectionTargetLinkDecodeFailure(malformed)).not.toContain(
      SECRET_BODY
    );
  });

  test("encode refuses unbounded identity fields", async () => {
    const target = await captureFixtureTarget(SECTION_FIXTURE_CONTENT, {
      anchor: "setup",
    });
    const hostile: SectionTargetV1 = {
      ...target,
      document: { uri: `gno://${"x".repeat(2000)}/doc.md` },
    };
    expect(encodeSectionTargetLinkParam(hostile)).toBeNull();
  });
});

describe("section target link recovery matrix", () => {
  test("exact and unique recovery stay navigable via encoded selectors", async () => {
    const exactTarget = await captureFixtureTarget(SECTION_FIXTURE_CONTENT, {
      anchor: "setup",
    });
    const exactEncoded = encodeSectionTargetLinkParam(exactTarget);
    expect(decodeSectionTargetLinkParam(exactEncoded!)).toEqual(exactTarget);

    const recoveredTarget = await captureFixtureTarget(
      SECTION_FIXTURE_CONTENT,
      {
        anchor: "setup",
      }
    );
    const recoveredEncoded = encodeSectionTargetLinkParam(recoveredTarget);
    const decoded = decodeSectionTargetLinkParam(recoveredEncoded!);
    expect(decoded).not.toBeNull();

    const recovered = await resolveSectionTarget({
      content: SECTION_RECOVERED_CONTENT,
      target: decoded!,
      uri: SECTION_FIXTURE_URI,
    });
    expect(isNavigableSectionResolution(recovered)).toBe(true);
    expect(recovered.status).toBe("recovered");
  });

  test("ambiguous stale and missing stay non-navigable", async () => {
    const twin = await createSectionTarget({
      content: SECTION_AMBIGUOUS_CONTENT,
      uri: SECTION_FIXTURE_URI,
      anchor: "twin",
    });
    expect(twin).not.toBeNull();

    // Same-revision structural match uses distinct anchors → exact.
    const sameRevision = await resolveSectionTarget({
      content: SECTION_AMBIGUOUS_CONTENT,
      target: twin!,
      uri: SECTION_FIXTURE_URI,
    });
    expect(sameRevision.status).toBe("exact");
    expect(isNavigableSectionResolution(sameRevision)).toBe(true);

    // Add a third identical twin so quote evidence is no longer unique.
    const moreIdentical = [
      SECTION_AMBIGUOUS_CONTENT,
      "",
      "## Twin",
      "",
      "Identical twin body text.",
    ].join("\n");
    const ambiguousAfterEdit = await resolveSectionTarget({
      content: moreIdentical,
      target: twin!,
      uri: SECTION_FIXTURE_URI,
    });
    expect(isNavigableSectionResolution(ambiguousAfterEdit)).toBe(false);
    expect(ambiguousAfterEdit.status).toBe("ambiguous");

    const setup = await captureFixtureTarget(SECTION_FIXTURE_CONTENT, {
      anchor: "setup",
    });
    const stale = await resolveSectionTarget({
      content: SECTION_STALE_CONTENT,
      target: setup,
      uri: SECTION_FIXTURE_URI,
    });
    expect(isNavigableSectionResolution(stale)).toBe(false);
    expect(stale.status).toBe("stale");

    const missing = await resolveSectionTarget({
      content: SECTION_MISSING_CONTENT,
      target: setup,
      uri: SECTION_FIXTURE_URI,
    });
    expect(isNavigableSectionResolution(missing)).toBe(false);
    expect(missing.status).toBe("missing");
  });

  test("duplicate headings keep distinct anchors in readable links", () => {
    const sections = extractSections(SECTION_AMBIGUOUS_CONTENT);
    expect(sections.map((section) => section.anchor)).toEqual([
      "guide",
      "twin",
      "twin-2",
    ]);
  });
});
