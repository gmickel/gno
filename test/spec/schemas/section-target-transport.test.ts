import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, test } from "bun:test";

import createResultSchema from "../../../spec/output-schemas/section-target-create-result.schema.json";
import resolveResultSchema from "../../../spec/output-schemas/section-target-resolve-result.schema.json";
import targetSchema from "../../../spec/output-schemas/section-target.schema.json";
import {
  CITATION_EXCEEDS_TRANSPORT_BOUNDS,
  SECTION_TARGET_BOUNDS,
  SECTION_TARGET_TRANSPORT_BOUNDS,
  createSectionTarget,
  isTransportBoundedCanonicalUri,
  isTransportBoundedCitation,
  parseSectionTargetCreateSelector,
  parseSectionTargetV1,
  projectSectionTargetCreateResult,
  projectSectionTargetResolveResult,
  resolveSectionTarget,
  type SectionResolution,
  type SectionTargetV1,
} from "../../../src/core/sections";
import {
  SECTION_FIXTURE_CONTENT,
  SECTION_FIXTURE_URI,
  SECTION_MISSING_CONTENT,
  SECTION_RECOVERED_CONTENT,
} from "../../helpers/section-target-fixtures";

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(targetSchema);
const validateCreate = ajv.compile(createResultSchema);
const validateResolve = ajv.compile(resolveResultSchema);
const validateTarget = ajv.compile(targetSchema);

const fingerprint = "a".repeat(64);

const baseTarget = (): SectionTargetV1 => ({
  schemaVersion: "1",
  document: { uri: SECTION_FIXTURE_URI },
  anchor: "setup",
  headingPath: ["Guide", "Setup"],
  occurrence: 1,
  quote: { exact: "Install Bun first.", prefix: "\n\n", suffix: "\n" },
  sourceFingerprint: fingerprint,
  hints: { line: 3, startOffset: 20, endOffset: 38 },
});

describe("section-target transport schemas", () => {
  test("create and navigable resolve projections match schemas", async () => {
    const target = await createSectionTarget({
      content: SECTION_FIXTURE_CONTENT,
      uri: SECTION_FIXTURE_URI,
      anchor: "setup",
    });
    expect(target).not.toBeNull();
    if (!target) return;

    const created = projectSectionTargetCreateResult(
      SECTION_FIXTURE_URI,
      target
    );
    expect(validateCreate(created)).toBe(true);

    const exact = await resolveSectionTarget({
      content: SECTION_FIXTURE_CONTENT,
      target,
      uri: SECTION_FIXTURE_URI,
    });
    const exactProjected = projectSectionTargetResolveResult(
      SECTION_FIXTURE_URI,
      exact
    );
    expect(validateResolve(exactProjected)).toBe(true);
    expect(exactProjected.citation).toBeDefined();

    const recovered = await resolveSectionTarget({
      content: SECTION_RECOVERED_CONTENT,
      target,
      uri: SECTION_FIXTURE_URI,
    });
    const recoveredProjected = projectSectionTargetResolveResult(
      SECTION_FIXTURE_URI,
      recovered
    );
    expect(validateResolve(recoveredProjected)).toBe(true);
    expect(recoveredProjected.status).toBe("recovered");
    expect(recoveredProjected.citation).toBeDefined();
  });

  test("non-navigable resolve projections omit citation", async () => {
    const target = await createSectionTarget({
      content: SECTION_FIXTURE_CONTENT,
      uri: SECTION_FIXTURE_URI,
      anchor: "setup",
    });
    expect(target).not.toBeNull();
    if (!target) return;

    const missing = await resolveSectionTarget({
      content: SECTION_MISSING_CONTENT,
      target,
      uri: SECTION_FIXTURE_URI,
    });
    const projected = projectSectionTargetResolveResult(
      SECTION_FIXTURE_URI,
      missing
    );
    expect(projected.status).toBe("missing");
    expect(projected.citation).toBeUndefined();
    expect(validateResolve(projected)).toBe(true);

    expect(
      validateResolve({
        ...projected,
        citation: {
          uri: SECTION_FIXTURE_URI,
          anchor: "setup",
          title: "Setup",
          lineStart: 3,
          lineEnd: 6,
          sourceFingerprint: projected.currentFingerprint,
        },
      })
    ).toBe(false);
  });

  test("caps >32 candidates with explicit count and truncation flag", () => {
    const total =
      SECTION_TARGET_TRANSPORT_BOUNDS.diagnosticsCandidatesMaxItems + 8;
    const candidates = Array.from({ length: total }, (_, index) => ({
      anchor: `twin-${index + 1}`,
      line: index + 1,
      title: "Twin",
      headingPath: ["Guide", "Twin"],
      occurrence: index + 1,
    }));
    const resolution: SectionResolution = {
      status: "ambiguous",
      target: baseTarget(),
      currentFingerprint: fingerprint,
      reason: "quote_context_multiple_matches",
      candidates,
    };

    const projected = projectSectionTargetResolveResult(
      SECTION_FIXTURE_URI,
      resolution
    );
    expect(projected.status).toBe("ambiguous");
    expect(projected.citation).toBeUndefined();
    expect(projected.diagnostics.candidateCount).toBe(total);
    expect(projected.diagnostics.candidatesTruncated).toBe(true);
    expect(projected.diagnostics.candidates).toHaveLength(
      SECTION_TARGET_TRANSPORT_BOUNDS.diagnosticsCandidatesMaxItems
    );
    expect(projected.diagnostics.candidates?.[0]?.anchor).toBe("twin-1");
    expect(projected.diagnostics.candidates?.at(-1)?.anchor).toBe(
      `twin-${SECTION_TARGET_TRANSPORT_BOUNDS.diagnosticsCandidatesMaxItems}`
    );
    expect(validateResolve(projected)).toBe(true);
  });

  test("filters oversized candidate identity without truncating strings", () => {
    const oversizedTitle = "T".repeat(
      SECTION_TARGET_TRANSPORT_BOUNDS.titleMaxChars + 1
    );
    const resolution: SectionResolution = {
      status: "ambiguous",
      target: baseTarget(),
      currentFingerprint: fingerprint,
      reason: "quote_context_multiple_matches",
      candidates: [
        {
          anchor: "ok",
          line: 1,
          title: "Ok",
          headingPath: ["Guide", "Ok"],
          occurrence: 1,
        },
        {
          anchor: "too-long",
          line: 2,
          title: oversizedTitle,
          headingPath: ["Guide", oversizedTitle],
          occurrence: 1,
        },
      ],
    };

    const projected = projectSectionTargetResolveResult(
      SECTION_FIXTURE_URI,
      resolution
    );
    expect(projected.diagnostics.candidateCount).toBe(2);
    expect(projected.diagnostics.candidatesTruncated).toBe(true);
    expect(projected.diagnostics.candidates).toEqual([
      {
        anchor: "ok",
        line: 1,
        title: "Ok",
        headingPath: ["Guide", "Ok"],
        occurrence: 1,
      },
    ]);
    expect(
      projected.diagnostics.candidates?.some((entry) =>
        entry.title.includes(oversizedTitle.slice(0, 8))
      )
    ).toBe(false);
    expect(validateResolve(projected)).toBe(true);
  });

  test("oversized recovered citation becomes stale without truncating identity", () => {
    const oversizedTitle = "R".repeat(
      SECTION_TARGET_TRANSPORT_BOUNDS.titleMaxChars + 40
    );
    const resolution: SectionResolution = {
      status: "recovered",
      target: baseTarget(),
      currentFingerprint: fingerprint,
      section: {
        anchor: "recovered",
        level: 2,
        line: 3,
        title: oversizedTitle,
        endLine: 6,
      },
    };

    const projected = projectSectionTargetResolveResult(
      SECTION_FIXTURE_URI,
      resolution
    );
    expect(projected.status).toBe("stale");
    expect(projected.citation).toBeUndefined();
    expect(projected.diagnostics.reason).toBe(
      CITATION_EXCEEDS_TRANSPORT_BOUNDS
    );
    expect(JSON.stringify(projected)).not.toContain(oversizedTitle);
    expect(validateResolve(projected)).toBe(true);
  });

  test("oversized top-level canonical URI is schema-invalid without substitution", () => {
    const oversizedUri = `gno://${"u".repeat(SECTION_TARGET_BOUNDS.uriMaxChars)}`;
    expect(isTransportBoundedCanonicalUri(oversizedUri)).toBe(false);
    expect(
      isTransportBoundedCanonicalUri(
        `gno://${"u".repeat(SECTION_TARGET_BOUNDS.uriMaxChars - 6)}`
      )
    ).toBe(true);

    const target = baseTarget();
    const created = projectSectionTargetCreateResult(oversizedUri, target);
    expect(created.uri).toBe(oversizedUri);
    expect(created.target.document.uri).toBe(SECTION_FIXTURE_URI);
    expect(validateCreate(created)).toBe(false);

    const missing: SectionResolution = {
      status: "missing",
      target,
      currentFingerprint: fingerprint,
      reason: "document_uri_mismatch",
    };
    const missingProjected = projectSectionTargetResolveResult(
      oversizedUri,
      missing
    );
    expect(missingProjected.uri).toBe(oversizedUri);
    expect(missingProjected.target.document.uri).toBe(SECTION_FIXTURE_URI);
    expect(missingProjected.citation).toBeUndefined();
    expect(validateResolve(missingProjected)).toBe(false);

    const exact: SectionResolution = {
      status: "exact",
      target,
      currentFingerprint: fingerprint,
      section: {
        anchor: "setup",
        level: 2,
        line: 3,
        title: "Setup",
        endLine: 6,
      },
    };
    const exactProjected = projectSectionTargetResolveResult(
      oversizedUri,
      exact
    );
    // Citation fail-closed drops citation but still emits unbound top-level uri.
    expect(exactProjected.status).toBe("stale");
    expect(exactProjected.citation).toBeUndefined();
    expect(exactProjected.uri).toBe(oversizedUri);
    expect(exactProjected.target.document.uri).toBe(SECTION_FIXTURE_URI);
    expect(validateResolve(exactProjected)).toBe(false);
  });

  test("citation predicate requires lineEnd >= lineStart", () => {
    const inverted = {
      uri: SECTION_FIXTURE_URI,
      anchor: "setup",
      title: "Setup",
      lineStart: 6,
      lineEnd: 3,
      sourceFingerprint: fingerprint,
    };
    expect(isTransportBoundedCitation(inverted)).toBe(false);

    const equal = { ...inverted, lineStart: 3, lineEnd: 3 };
    expect(isTransportBoundedCitation(equal)).toBe(true);

    const resolution: SectionResolution = {
      status: "exact",
      target: baseTarget(),
      currentFingerprint: fingerprint,
      section: {
        anchor: "setup",
        level: 2,
        line: 6,
        title: "Setup",
        endLine: 3,
      },
    };
    const projected = projectSectionTargetResolveResult(
      SECTION_FIXTURE_URI,
      resolution
    );
    expect(projected.status).toBe("stale");
    expect(projected.citation).toBeUndefined();
    expect(projected.diagnostics.reason).toBe(
      CITATION_EXCEEDS_TRANSPORT_BOUNDS
    );
    expect(validateResolve(projected)).toBe(true);
  });
});

describe("section-target transport input validation", () => {
  test("rejects unsafe integers for selector line, occurrence, and hints", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;

    expect(parseSectionTargetCreateSelector({ line: unsafe }).ok).toBe(false);
    expect(parseSectionTargetCreateSelector({ line: 1.5 }).ok).toBe(false);
    expect(parseSectionTargetCreateSelector({ line: 0 }).ok).toBe(false);

    const target = baseTarget();
    expect(validateTarget(target)).toBe(true);

    expect(parseSectionTargetV1({ ...target, occurrence: unsafe }).ok).toBe(
      false
    );
    expect(
      parseSectionTargetV1({
        ...target,
        hints: { ...target.hints, line: unsafe },
      }).ok
    ).toBe(false);
    expect(
      parseSectionTargetV1({
        ...target,
        hints: { ...target.hints, startOffset: unsafe },
      }).ok
    ).toBe(false);
    expect(
      parseSectionTargetV1({
        ...target,
        hints: { ...target.hints, endOffset: unsafe },
      }).ok
    ).toBe(false);

    expect(validateTarget({ ...target, occurrence: unsafe })).toBe(false);
    expect(
      validateTarget({
        ...target,
        hints: { ...target.hints, line: unsafe },
      })
    ).toBe(false);
  });

  test("requires hints.endOffset >= hints.startOffset", () => {
    const target = baseTarget();
    const inverted = parseSectionTargetV1({
      ...target,
      hints: { line: 3, startOffset: 40, endOffset: 10 },
    });
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) {
      expect(inverted.error).toContain("hints.endOffset");
    }

    const equal = parseSectionTargetV1({
      ...target,
      hints: { line: 3, startOffset: 10, endOffset: 10 },
    });
    expect(equal.ok).toBe(true);
  });

  test("accepts safe integer bounds at Number.MAX_SAFE_INTEGER", () => {
    const target = {
      ...baseTarget(),
      occurrence: Number.MAX_SAFE_INTEGER,
      hints: {
        line: Number.MAX_SAFE_INTEGER,
        startOffset: Number.MAX_SAFE_INTEGER - 1,
        endOffset: Number.MAX_SAFE_INTEGER,
      },
    };
    // URI/quote/fingerprint still bounded; numeric fields alone must parse.
    expect(parseSectionTargetV1(target).ok).toBe(true);
    expect(validateTarget(target)).toBe(true);
  });

  test("rejects oversized serialized targets via isBoundedSectionTarget", () => {
    // Field lengths are individually legal; combined UTF-8 JSON exceeds budget.
    const target = {
      ...baseTarget(),
      document: {
        uri: `gno://${"u".repeat(SECTION_TARGET_BOUNDS.uriMaxChars - 6)}`,
      },
      anchor: "a".repeat(SECTION_TARGET_BOUNDS.anchorMaxChars),
      headingPath: Array.from(
        { length: SECTION_TARGET_BOUNDS.headingPathMaxItems },
        (_, index) =>
          `${index}${"H".repeat(SECTION_TARGET_BOUNDS.headingPathItemMaxChars - 1)}`
      ),
      quote: {
        exact: "x".repeat(SECTION_TARGET_BOUNDS.exactMaxChars),
        prefix: "y".repeat(SECTION_TARGET_BOUNDS.prefixMaxChars),
        suffix: "z".repeat(SECTION_TARGET_BOUNDS.suffixMaxChars),
      },
    };
    expect(target.document.uri.length).toBe(SECTION_TARGET_BOUNDS.uriMaxChars);
    const parsed = parseSectionTargetV1(target);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toBe("Section target exceeds size bounds");
    }
  });
});
