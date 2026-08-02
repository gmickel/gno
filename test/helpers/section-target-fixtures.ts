/**
 * Shared semantic fixture matrix for section-target REST/SDK tests.
 *
 * @module test/helpers/section-target-fixtures
 */

import type { SectionTargetV1 } from "../../src/core/sections";

import {
  createSectionTarget,
  fingerprintSourceContent,
} from "../../src/core/sections";

export const SECTION_FIXTURE_URI = "gno://work/notes/pilot.md";

export const SECTION_FIXTURE_CONTENT = [
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

export const SECTION_RECOVERED_CONTENT = [
  "# Guide",
  "",
  "## Getting Started",
  "",
  "Install Bun first.",
  "Then run tests.",
  "",
  "## Usage",
  "",
  "Call createSectionTarget.",
].join("\n");

export const SECTION_AMBIGUOUS_CONTENT = [
  "# Guide",
  "",
  "## Twin",
  "",
  "Identical twin body text.",
  "",
  "## Twin",
  "",
  "Identical twin body text.",
].join("\n");

export const SECTION_STALE_CONTENT = [
  "# Guide",
  "",
  "## Setup",
  "",
  "Completely different body with no recoverable quote.",
].join("\n");

export const SECTION_MISSING_CONTENT = ["# Guide", "", "No setup here."].join(
  "\n"
);

export type SectionSemanticCase =
  | "exact"
  | "recovered"
  | "ambiguous"
  | "stale"
  | "missing";

export interface SectionSemanticFixture {
  id: SectionSemanticCase;
  captureContent: string;
  resolveContent: string;
  selector: { anchor: string } | { line: number };
  expectedStatus: SectionSemanticCase;
  navigable: boolean;
}

/** One semantic matrix reused across REST and SDK tests. */
export const SECTION_SEMANTIC_CASES: readonly SectionSemanticFixture[] = [
  {
    id: "exact",
    captureContent: SECTION_FIXTURE_CONTENT,
    resolveContent: SECTION_FIXTURE_CONTENT,
    selector: { anchor: "setup" },
    expectedStatus: "exact",
    navigable: true,
  },
  {
    id: "recovered",
    captureContent: SECTION_FIXTURE_CONTENT,
    resolveContent: SECTION_RECOVERED_CONTENT,
    selector: { anchor: "setup" },
    expectedStatus: "recovered",
    navigable: true,
  },
  {
    id: "ambiguous",
    captureContent: SECTION_AMBIGUOUS_CONTENT,
    resolveContent: [
      "# Guide",
      "",
      "## Twin",
      "",
      "Identical twin body text.",
      "",
      "## Twin",
      "",
      "Identical twin body text.",
      "",
      "## Twin",
      "",
      "Identical twin body text.",
    ].join("\n"),
    selector: { line: 3 },
    expectedStatus: "ambiguous",
    navigable: false,
  },
  {
    id: "stale",
    captureContent: SECTION_FIXTURE_CONTENT,
    resolveContent: SECTION_STALE_CONTENT,
    selector: { anchor: "setup" },
    expectedStatus: "stale",
    navigable: false,
  },
  {
    id: "missing",
    captureContent: SECTION_FIXTURE_CONTENT,
    resolveContent: SECTION_MISSING_CONTENT,
    selector: { anchor: "setup" },
    expectedStatus: "missing",
    navigable: false,
  },
];

export async function captureFixtureTarget(
  content: string,
  selector: { anchor?: string; line?: number },
  uri = SECTION_FIXTURE_URI
): Promise<SectionTargetV1> {
  const target = await createSectionTarget({
    content,
    uri,
    ...selector,
  });
  if (!target) {
    throw new Error("Failed to capture fixture section target");
  }
  return target;
}

export async function wrongDocumentTarget(
  content: string
): Promise<SectionTargetV1> {
  const target = await captureFixtureTarget(content, { anchor: "setup" });
  return {
    ...target,
    document: { uri: "gno://other/wrong.md" },
    sourceFingerprint: await fingerprintSourceContent(content),
  };
}
