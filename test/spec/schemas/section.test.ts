/**
 * Contract tests for gno://schemas/section@1.0 MCP output schema.
 */

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, test } from "bun:test";

import resolveResultSchema from "../../../spec/output-schemas/section-target-resolve-result.schema.json";
import targetSchema from "../../../spec/output-schemas/section-target.schema.json";
import sectionSchema from "../../../spec/output-schemas/section.schema.json";
import {
  createSectionTarget,
  projectSectionTargetCreateResult,
  projectSectionTargetResolveResult,
  resolveSectionTarget,
} from "../../../src/core/sections";
import { sectionOutputSchema } from "../../../src/mcp/tools/sections";
import {
  SECTION_FIXTURE_CONTENT,
  SECTION_FIXTURE_URI,
  SECTION_STALE_CONTENT,
} from "../../helpers/section-target-fixtures";
import { loadSchema } from "./validator";

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(targetSchema);
ajv.addSchema(resolveResultSchema);
const validate = ajv.compile(sectionSchema);

const fingerprint = "a".repeat(64);

describe("section MCP output schema", () => {
  test("is wired into the shared schema validator catalog", async () => {
    const loaded = await loadSchema("section");
    expect(loaded).toMatchObject({ $id: "gno://schemas/section@1.0" });
  });

  test("accepts create and navigable/non-navigable resolve branches", async () => {
    const target = await createSectionTarget({
      content: SECTION_FIXTURE_CONTENT,
      uri: SECTION_FIXTURE_URI,
      anchor: "setup",
    });
    expect(target).toBeTruthy();
    if (!target) return;

    const createResult = {
      schemaVersion: "1.0" as const,
      action: "create" as const,
      ...projectSectionTargetCreateResult(SECTION_FIXTURE_URI, target),
    };
    expect(validate(createResult)).toBe(true);

    const exact = await resolveSectionTarget({
      content: SECTION_FIXTURE_CONTENT,
      target,
      uri: SECTION_FIXTURE_URI,
    });
    const exactProjected = projectSectionTargetResolveResult(
      SECTION_FIXTURE_URI,
      exact
    );
    const exactResult = {
      schemaVersion: "1.0" as const,
      action: "resolve" as const,
      ...exactProjected,
    };
    expect(validate(exactResult)).toBe(true);

    const stale = await resolveSectionTarget({
      content: SECTION_STALE_CONTENT,
      target,
      uri: SECTION_FIXTURE_URI,
    });
    const staleProjected = projectSectionTargetResolveResult(
      SECTION_FIXTURE_URI,
      stale
    );
    const staleResult = {
      schemaVersion: "1.0" as const,
      action: "resolve" as const,
      ...staleProjected,
    };
    expect(validate(staleResult)).toBe(true);
    expect(staleResult).not.toHaveProperty("citation");
  });

  test("rejects citation on non-navigable status and unknown fields", () => {
    expect(
      validate({
        schemaVersion: "1.0",
        action: "resolve",
        uri: SECTION_FIXTURE_URI,
        status: "missing",
        currentFingerprint: fingerprint,
        target: {
          schemaVersion: "1",
          document: { uri: SECTION_FIXTURE_URI },
          anchor: "setup",
          headingPath: ["Guide", "Setup"],
          occurrence: 1,
          quote: { exact: "x", prefix: "", suffix: "" },
          sourceFingerprint: fingerprint,
          hints: { line: 3, startOffset: 0, endOffset: 1 },
        },
        diagnostics: {},
        citation: {
          uri: SECTION_FIXTURE_URI,
          anchor: "setup",
          title: "Setup",
          lineStart: 3,
          lineEnd: 4,
          sourceFingerprint: fingerprint,
        },
      })
    ).toBe(false);

    expect(
      validate({
        schemaVersion: "1.0",
        action: "create",
        uri: SECTION_FIXTURE_URI,
        target: {
          schemaVersion: "1",
          document: { uri: SECTION_FIXTURE_URI },
          anchor: "setup",
          headingPath: ["Guide", "Setup"],
          occurrence: 1,
          quote: { exact: "x", prefix: "", suffix: "" },
          sourceFingerprint: fingerprint,
          hints: { line: 3, startOffset: 0, endOffset: 1 },
        },
        extra: true,
      })
    ).toBe(false);
  });

  test("enforces diagnostics co-dependencies and citation line ordering", () => {
    const target = {
      schemaVersion: "1",
      document: { uri: SECTION_FIXTURE_URI },
      anchor: "setup",
      headingPath: ["Guide", "Setup"],
      occurrence: 1,
      quote: { exact: "x", prefix: "", suffix: "" },
      sourceFingerprint: fingerprint,
      hints: { line: 3, startOffset: 0, endOffset: 1 },
    };

    expect(
      validate({
        schemaVersion: "1.0",
        action: "resolve",
        uri: SECTION_FIXTURE_URI,
        status: "ambiguous",
        currentFingerprint: fingerprint,
        target,
        diagnostics: {
          candidates: [
            {
              anchor: "setup",
              line: 3,
              title: "Setup",
              headingPath: ["Guide", "Setup"],
              occurrence: 1,
            },
          ],
        },
      })
    ).toBe(false);

    expect(
      validate({
        schemaVersion: "1.0",
        action: "resolve",
        uri: SECTION_FIXTURE_URI,
        status: "ambiguous",
        currentFingerprint: fingerprint,
        target,
        diagnostics: {
          candidates: [
            {
              anchor: "setup",
              line: 3,
              title: "Setup",
              headingPath: ["Guide", "Setup"],
              occurrence: 1,
            },
          ],
          candidateCount: 1,
          candidatesTruncated: false,
        },
      })
    ).toBe(true);

    const invertedCitation = {
      schemaVersion: "1.0",
      action: "resolve" as const,
      uri: SECTION_FIXTURE_URI,
      status: "exact" as const,
      currentFingerprint: fingerprint,
      target,
      diagnostics: {},
      citation: {
        uri: SECTION_FIXTURE_URI,
        anchor: "setup",
        title: "Setup",
        lineStart: 6,
        lineEnd: 3,
        sourceFingerprint: fingerprint,
      },
    };
    // JSON Schema allows the integers; Zod output schema rejects inverted lines.
    expect(validate(invertedCitation)).toBe(true);
    expect(sectionOutputSchema.safeParse(invertedCitation).success).toBe(false);
  });
});
