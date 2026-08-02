import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, test } from "bun:test";

import sectionTargetSchema from "../../spec/output-schemas/section-target.schema.json";
import {
  SECTION_TARGET_BOUNDS,
  createSectionTarget,
  extractSections,
  isNavigableSectionResolution,
  resolveSectionTarget,
  type SectionTargetV1,
} from "../../src/core/sections";

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const validateTarget = ajv.compile(sectionTargetSchema);

const DOC_URI = "gno://work/notes/pilot.md";

const assertTargetSchema = (target: SectionTargetV1): void => {
  const valid = validateTarget(target);
  if (!valid) {
    throw new Error(
      `Section target schema validation failed:\n${JSON.stringify(validateTarget.errors, null, 2)}`
    );
  }
};

const bytesOf = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

describe("sections", () => {
  test("extracts headings with stable duplicate anchors", () => {
    const sections = extractSections(
      `# Alpha\n\n## Beta\n\n## Beta\n\n### Gamma`
    );

    expect(sections).toEqual([
      { anchor: "alpha", level: 1, line: 1, title: "Alpha" },
      { anchor: "beta", level: 2, line: 3, title: "Beta" },
      { anchor: "beta-2", level: 2, line: 5, title: "Beta" },
      { anchor: "gamma", level: 3, line: 7, title: "Gamma" },
    ]);
  });

  test("ignores headings inside matching backtick and tilde fences", () => {
    const content = [
      "# Outside",
      "```ts",
      "## Backtick decoy",
      "~~~",
      "``",
      "```",
      "## Between",
      "~~~~ note",
      "### Tilde decoy",
      "```",
      "~~~",
      "~~~~",
      "### After",
    ].join("\n");

    expect(extractSections(content)).toEqual([
      { anchor: "outside", level: 1, line: 1, title: "Outside" },
      { anchor: "between", level: 2, line: 7, title: "Between" },
      { anchor: "after", level: 3, line: 13, title: "After" },
    ]);
  });

  test("supports ATX headings with optional closing markers", () => {
    const sections = extractSections(
      `# Open\n\n## Closed ##\n\n### Spaced close   ###`
    );
    expect(sections.map((section) => section.title)).toEqual([
      "Open",
      "Closed",
      "Spaced close",
    ]);
    expect(sections.map((section) => section.anchor)).toEqual([
      "open",
      "closed",
      "spaced-close",
    ]);
  });
});

describe("section targets", () => {
  test("creates a bounded versioned target that preserves the human anchor", async () => {
    const content = [
      "# Guide",
      "",
      "## Setup",
      "",
      "Install Bun first.",
      "Then run tests.",
      "",
      "## Usage",
      "",
      "Call createSectionTarget.",
    ].join("\n");

    const target = await createSectionTarget({
      content,
      uri: DOC_URI,
      anchor: "setup",
    });

    expect(target).not.toBeNull();
    if (!target) return;

    expect(target.schemaVersion).toBe("1");
    expect(target.document.uri).toBe(DOC_URI);
    expect(target.anchor).toBe("setup");
    expect(target.headingPath).toEqual(["Guide", "Setup"]);
    expect(target.occurrence).toBe(1);
    expect(target.quote.exact).toContain("Install Bun first.");
    expect(target.quote.exact.length).toBeLessThanOrEqual(
      SECTION_TARGET_BOUNDS.exactMaxChars
    );
    expect(target.quote.prefix.length).toBeLessThanOrEqual(
      SECTION_TARGET_BOUNDS.prefixMaxChars
    );
    expect(target.quote.suffix.length).toBeLessThanOrEqual(
      SECTION_TARGET_BOUNDS.suffixMaxChars
    );
    expect(target.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(target.hints.line).toBe(3);
    expect(bytesOf(JSON.stringify(target))).toBeLessThanOrEqual(
      SECTION_TARGET_BOUNDS.maxSerializedBytes
    );
    assertTargetSchema(target);

    const exact = await resolveSectionTarget({ content, target, uri: DOC_URI });
    expect(exact.status).toBe("exact");
    expect(isNavigableSectionResolution(exact)).toBe(true);
    if (exact.section) {
      expect(exact.section.anchor).toBe("setup");
      expect(exact.section.line).toBe(3);
    }
  });

  test("recovers after duplicate heading insertion via quote context", async () => {
    const original = [
      "# Alpha",
      "",
      "## Beta",
      "",
      "Original beta body with unique marker ONE.",
      "",
      "## Gamma",
      "",
      "Tail.",
    ].join("\n");

    const target = await createSectionTarget({
      content: original,
      uri: DOC_URI,
      anchor: "beta",
    });
    expect(target).not.toBeNull();
    if (!target) return;

    const edited = [
      "# Alpha",
      "",
      "## Beta",
      "",
      "Inserted decoy body with marker TWO.",
      "",
      "## Beta",
      "",
      "Original beta body with unique marker ONE.",
      "",
      "## Gamma",
      "",
      "Tail.",
    ].join("\n");

    const resolution = await resolveSectionTarget({
      content: edited,
      target,
      uri: DOC_URI,
    });

    expect(resolution.status).toBe("recovered");
    expect(isNavigableSectionResolution(resolution)).toBe(true);
    expect(resolution.section?.anchor).toBe("beta-2");
    expect(resolution.section?.line).toBe(7);
    expect(resolution.currentFingerprint).not.toBe(target.sourceFingerprint);
  });

  test("recovers after heading rename when body quote remains unique", async () => {
    const original = [
      "# Doc",
      "",
      "## Old Name",
      "",
      "Rename-stable paragraph about widgets.",
      "",
      "## Other",
      "",
      "Unrelated.",
    ].join("\n");

    const target = await createSectionTarget({
      content: original,
      uri: DOC_URI,
      anchor: "old-name",
    });
    expect(target).not.toBeNull();
    if (!target) return;

    const renamed = [
      "# Doc",
      "",
      "## New Name",
      "",
      "Rename-stable paragraph about widgets.",
      "",
      "## Other",
      "",
      "Unrelated.",
    ].join("\n");

    const resolution = await resolveSectionTarget({
      content: renamed,
      target,
      uri: DOC_URI,
    });

    expect(resolution.status).toBe("recovered");
    expect(resolution.section?.anchor).toBe("new-name");
    expect(resolution.section?.title).toBe("New Name");
  });

  test("recovers after section reorder when quote context is unique", async () => {
    const original = [
      "# Doc",
      "",
      "## First",
      "",
      "First body alpha.",
      "",
      "## Second",
      "",
      "Second body bravo.",
    ].join("\n");

    const target = await createSectionTarget({
      content: original,
      uri: DOC_URI,
      anchor: "second",
    });
    expect(target).not.toBeNull();
    if (!target) return;

    const reordered = [
      "# Doc",
      "",
      "## Second",
      "",
      "Second body bravo.",
      "",
      "## First",
      "",
      "First body alpha.",
    ].join("\n");

    const resolution = await resolveSectionTarget({
      content: reordered,
      target,
      uri: DOC_URI,
    });

    expect(resolution.status).toBe("recovered");
    expect(resolution.section?.anchor).toBe("second");
    expect(resolution.section?.line).toBe(3);
  });

  test("returns missing after section deletion", async () => {
    const original = [
      "# Doc",
      "",
      "## Keep",
      "",
      "Keep body.",
      "",
      "## Delete Me",
      "",
      "Gone soon.",
    ].join("\n");

    const target = await createSectionTarget({
      content: original,
      uri: DOC_URI,
      anchor: "delete-me",
    });
    expect(target).not.toBeNull();
    if (!target) return;

    const deleted = ["# Doc", "", "## Keep", "", "Keep body."].join("\n");
    const resolution = await resolveSectionTarget({
      content: deleted,
      target,
      uri: DOC_URI,
    });

    expect(resolution.status).toBe("missing");
    expect(isNavigableSectionResolution(resolution)).toBe(false);
    expect(resolution.section).toBeUndefined();
  });

  test("returns ambiguous for indistinguishable identical sections", async () => {
    const identical = [
      "# Doc",
      "",
      "## Twin",
      "",
      "Same body text.",
      "",
      "## Twin",
      "",
      "Same body text.",
    ].join("\n");

    const target = await createSectionTarget({
      content: identical,
      uri: DOC_URI,
      anchor: "twin",
    });
    expect(target).not.toBeNull();
    if (!target) return;

    // Fingerprint-changing no-op whitespace outside sections is insufficient;
    // swap in a third identical twin so quote evidence is no longer unique.
    const moreIdentical = [
      identical,
      "",
      "## Twin",
      "",
      "Same body text.",
    ].join("\n");

    const resolution = await resolveSectionTarget({
      content: moreIdentical,
      target,
      uri: DOC_URI,
    });

    expect(resolution.status).toBe("ambiguous");
    expect(isNavigableSectionResolution(resolution)).toBe(false);
    expect(resolution.section).toBeUndefined();
    expect(resolution.candidates?.length).toBeGreaterThan(1);
  });

  test("returns stale when fingerprint drifts without unique recovery", async () => {
    const original = [
      "# Doc",
      "",
      "## Topic",
      "",
      "Unique original wording.",
      "",
      "## Other",
      "",
      "Other body.",
    ].join("\n");

    const target = await createSectionTarget({
      content: original,
      uri: DOC_URI,
      anchor: "topic",
    });
    expect(target).not.toBeNull();
    if (!target) return;

    const drifted = [
      "# Doc",
      "",
      "## Topic",
      "",
      "Completely rewritten body with no shared quote.",
      "",
      "## Other",
      "",
      "Other body.",
    ].join("\n");

    const resolution = await resolveSectionTarget({
      content: drifted,
      target,
      uri: DOC_URI,
    });

    expect(resolution.status).toBe("stale");
    expect(isNavigableSectionResolution(resolution)).toBe(false);
    expect(resolution.section).toBeUndefined();
  });

  test("does not treat fenced decoy headings as resolvable sections", async () => {
    const content = [
      "# Real",
      "",
      "```md",
      "## Fake",
      "fenced decoy body",
      "```",
      "",
      "## Fake",
      "",
      "Real fake section body.",
    ].join("\n");

    const target = await createSectionTarget({
      content,
      uri: DOC_URI,
      anchor: "fake",
    });
    expect(target).not.toBeNull();
    if (!target) return;

    expect(target.headingPath).toEqual(["Real", "Fake"]);
    expect(target.quote.exact).toContain("Real fake section body.");

    const resolution = await resolveSectionTarget({
      content,
      target,
      uri: DOC_URI,
    });
    expect(resolution.status).toBe("exact");
    expect(resolution.section?.line).toBe(8);
  });

  test("never navigates ambiguous or stale targets", async () => {
    const content = ["# A", "", "## B", "", "Body."].join("\n");
    const target = await createSectionTarget({
      content,
      uri: DOC_URI,
      anchor: "b",
    });
    expect(target).not.toBeNull();
    if (!target) return;

    const stale = await resolveSectionTarget({
      content: ["# A", "", "## B", "", "Changed."].join("\n"),
      target,
      uri: DOC_URI,
    });
    expect(["stale", "missing", "ambiguous"]).toContain(stale.status);
    expect(isNavigableSectionResolution(stale)).toBe(false);
  });

  test("fails closed on oversized heading path without truncating identity", async () => {
    const content = `# ${"x".repeat(3000)}\n`;
    const target = await createSectionTarget({
      content,
      uri: "gno://x",
      line: 1,
    });
    expect(target).toBeNull();
  });

  test("fails closed on oversized document URI without truncating identity", async () => {
    const content = "# Short\n\nBody.\n";
    const target = await createSectionTarget({
      content,
      uri: `gno://${"u".repeat(SECTION_TARGET_BOUNDS.uriMaxChars)}`,
      line: 1,
    });
    expect(target).toBeNull();
  });

  test("preserves ordinary Unicode in heading path and quote evidence", async () => {
    const content = [
      "# Café résumé",
      "",
      "## 日本語ガイド",
      "",
      "本文 with naïve résumé notes.",
    ].join("\n");

    const target = await createSectionTarget({
      content,
      uri: DOC_URI,
      line: 3,
    });
    expect(target).not.toBeNull();
    if (!target) return;

    expect(target.headingPath).toEqual(["Café résumé", "日本語ガイド"]);
    expect(target.quote.exact).toContain("naïve");
    expect(bytesOf(JSON.stringify(target))).toBeLessThanOrEqual(
      SECTION_TARGET_BOUNDS.maxSerializedBytes
    );
    assertTargetSchema(target);

    const resolution = await resolveSectionTarget({
      content,
      target,
      uri: DOC_URI,
    });
    expect(resolution.status).toBe("exact");
    expect(resolution.section?.title).toBe("日本語ガイド");
  });
});
