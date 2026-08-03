/**
 * Representative fixture matrix for reference-safe rename/move contracts.
 *
 * These fixtures characterize expected later planner behavior without
 * implementing the full parser-backed planner (fn-60.6).
 *
 * @module test/core/file-refactor-fixtures
 */

import type {
  FileRefactorDestinationSpan,
  FileRefactorExaminedReference,
  FileRefactorReasonCode,
  FileRefactorReferenceClassification,
  FileRefactorReferenceKind,
} from "../../src/core/file-refactors";

/**
 * Optional planner-drive metadata so adversarial suites can exercise the
 * live parser/planner against the same fixture rows (no duplicated cases).
 */
export interface FileRefactorFixturePlannerMeta {
  operation: "rename" | "move";
  sourceRelPath: string;
  sourceTitle: string;
  targetRelPath: string;
  targetTitle: string;
  referringRelPath?: string;
  /** Extra catalog docs (duplicate basenames, path siblings, etc.). */
  catalogExtras?: Array<{
    relPath: string;
    title: string;
    content?: string;
  }>;
  /** Exact proposed destination token the planner must emit when rewriteable. */
  expectedProposedDestination?: string;
}

export interface FileRefactorFixtureCase {
  id: string;
  category: string;
  /** Referring document content containing the link under test. */
  content: string;
  /** Destination token currently inside the link (path portion only). */
  originalDestination: string;
  /** Proposed destination after rename/move (path portion only). */
  replacementDestination: string;
  /** UTF-16 code-unit start of destination-only span within `content`. */
  destinationStart: number;
  kind: FileRefactorReferenceKind;
  classification: FileRefactorReferenceClassification;
  reasonCode?: FileRefactorReasonCode;
  /**
   * Substrings that must remain identical after a destination-only edit
   * (aliases, labels, titles, fragments, queries, fences, etc.).
   */
  mustPreserve: string[];
  notes: string;
  /** When set, adversarial suites plan this fixture through the live planner. */
  planner?: FileRefactorFixturePlannerMeta;
}

function destSpan(
  content: string,
  start: number,
  original: string,
  replacement: string
): FileRefactorDestinationSpan {
  return {
    coordinateSpace: "utf16_code_units",
    startOffset: start,
    endOffset: start + original.length,
    originalDestination: original,
    replacementDestination: replacement,
  };
}

/** Build the expected examined-reference row a later planner should emit. */
export function fixtureToExaminedReference(
  fixture: FileRefactorFixtureCase,
  documentUri = "gno://notes/referrer.md",
  documentRelPath = "referrer.md"
): FileRefactorExaminedReference {
  const base: FileRefactorExaminedReference = {
    documentUri,
    documentRelPath,
    kind: fixture.kind,
    classification: fixture.classification,
    originalDestination: fixture.originalDestination,
    proposedDestination:
      fixture.classification === "rewriteable"
        ? fixture.replacementDestination
        : fixture.originalDestination,
    startLine: 1,
    startCol: 1,
  };
  if (fixture.reasonCode) {
    base.reasonCode = fixture.reasonCode;
  }
  if (fixture.classification === "rewriteable") {
    base.edit = destSpan(
      fixture.content,
      fixture.destinationStart,
      fixture.originalDestination,
      fixture.replacementDestination
    );
  }
  return base;
}

/**
 * Matrix covering aliases, fragments, titles, reference defs, relative paths,
 * duplicates, Unicode, encoding, fences, HTML, malformed, and unsupported
 * Obsidian syntax. Existing simple path planners remain separately tested.
 */
const renameOldNote = {
  operation: "rename" as const,
  sourceRelPath: "old-note.md",
  sourceTitle: "Old Note",
  targetRelPath: "new-note.md",
  targetTitle: "New Note",
};

export const FILE_REFACTOR_FIXTURE_MATRIX: FileRefactorFixtureCase[] = [
  {
    id: "wiki-alias",
    category: "alias",
    content: "See [[Old Note|Display Alias]] today.",
    originalDestination: "Old Note",
    replacementDestination: "New Note",
    destinationStart: 6,
    kind: "wiki",
    classification: "rewriteable",
    mustPreserve: ["|Display Alias"],
    notes: "Wiki alias after | stays outside the destination span.",
    planner: { ...renameOldNote, expectedProposedDestination: "New Note" },
  },
  {
    id: "wiki-fragment",
    category: "fragment",
    content: "Jump [[Old Note#Heading]] here.",
    originalDestination: "Old Note",
    replacementDestination: "New Note",
    destinationStart: 7,
    kind: "wiki",
    classification: "rewriteable",
    mustPreserve: ["#Heading"],
    notes: "Heading/block fragment remains outside the replacement span.",
    planner: { ...renameOldNote, expectedProposedDestination: "New Note" },
  },
  {
    id: "markdown-label-title",
    category: "label-title",
    content: 'Read [Label Text](old-note.md "Title Text") now.',
    originalDestination: "old-note.md",
    replacementDestination: "new-note.md",
    destinationStart: 18,
    kind: "markdown",
    classification: "rewriteable",
    mustPreserve: ["[Label Text]", '"Title Text"'],
    notes: "CommonMark label and title stay outside destination token.",
    planner: { ...renameOldNote, expectedProposedDestination: "new-note.md" },
  },
  {
    id: "markdown-reference-definition",
    category: "reference-definition",
    content: '[ref]: ./old-note.md "def title"\n\nSee [ref][ref].\n',
    originalDestination: "./old-note.md",
    replacementDestination: "./folder/new-note.md",
    destinationStart: 7,
    kind: "markdown_definition",
    classification: "rewriteable",
    reasonCode: "reference_definition_site",
    mustPreserve: ['"def title"', "[ref][ref]"],
    notes: "Rewrite at definition site only; uses stay content-identical.",
    planner: {
      operation: "move",
      sourceRelPath: "old-note.md",
      sourceTitle: "Old Note",
      targetRelPath: "folder/new-note.md",
      targetTitle: "New Note",
      expectedProposedDestination: "./folder/new-note.md",
    },
  },
  {
    id: "markdown-relative-path",
    category: "relative-path",
    content: "Link [x](../old-note.md) please.",
    originalDestination: "../old-note.md",
    replacementDestination: "../archive/new-note.md",
    destinationStart: 9,
    kind: "markdown",
    classification: "rewriteable",
    reasonCode: "relative_path_recalculated",
    mustPreserve: ["[x]"],
    notes: "Relative destination recalculated from the referring document.",
    planner: {
      operation: "move",
      sourceRelPath: "old-note.md",
      sourceTitle: "Old Note",
      targetRelPath: "archive/new-note.md",
      targetTitle: "New Note",
      referringRelPath: "folder/referrer.md",
      expectedProposedDestination: "../archive/new-note.md",
    },
  },
  {
    id: "markdown-angle-destination",
    category: "angle-destination",
    content: 'Go [x](<old note.md#frag> "T") end.',
    originalDestination: "old note.md",
    replacementDestination: "new note.md",
    destinationStart: 8,
    kind: "markdown",
    classification: "rewriteable",
    mustPreserve: ["<", ">", "#frag", '"T"'],
    notes: "Angle-bracket destination keeps <> and fragment outside the span.",
    planner: {
      operation: "rename",
      sourceRelPath: "old note.md",
      sourceTitle: "Old Note",
      targetRelPath: "new note.md",
      targetTitle: "New Note",
      expectedProposedDestination: "new note.md",
    },
  },
  {
    id: "markdown-escaped-space",
    category: "escaping",
    content: 'Go [x](old\\ note.md#frag "Title") end.',
    originalDestination: "old\\ note.md",
    replacementDestination: "new\\ note.md",
    destinationStart: 7,
    kind: "markdown",
    classification: "rewriteable",
    mustPreserve: ["#frag", '"Title"'],
    notes: "Backslash-escaped spaces keep escape style on the path token.",
    planner: {
      operation: "rename",
      sourceRelPath: "old note.md",
      sourceTitle: "Old Note",
      targetRelPath: "new note.md",
      targetTitle: "New Note",
      expectedProposedDestination: "new\\ note.md",
    },
  },
  {
    id: "markdown-escaped-parens",
    category: "escaping",
    content: "Go [x](foo\\(bar\\).md?q=1#h) end.",
    originalDestination: "foo\\(bar\\).md",
    replacementDestination: "baz\\(qux\\).md",
    destinationStart: 7,
    kind: "markdown",
    classification: "rewriteable",
    mustPreserve: ["?q=1", "#h"],
    notes: "Escaped parentheses preserve escape style plus query/fragment.",
    planner: {
      operation: "rename",
      sourceRelPath: "foo(bar).md",
      sourceTitle: "Foo Bar",
      targetRelPath: "baz(qux).md",
      targetTitle: "Baz Qux",
      expectedProposedDestination: "baz\\(qux\\).md",
    },
  },
  {
    id: "duplicate-basename-ambiguous",
    category: "duplicate-names",
    content: "See [[Shared Name]] in vault.",
    originalDestination: "Shared Name",
    replacementDestination: "Shared Name",
    destinationStart: 6,
    kind: "wiki",
    classification: "ambiguous",
    reasonCode: "duplicate_basename_ambiguity",
    mustPreserve: ["[[Shared Name]]"],
    notes: "Multiple same-basename targets fail closed as ambiguous.",
    planner: {
      operation: "rename",
      sourceRelPath: "a/shared-name.md",
      sourceTitle: "Shared Name",
      targetRelPath: "a/renamed.md",
      targetTitle: "Renamed",
      catalogExtras: [{ relPath: "b/shared-name.md", title: "Shared Name" }],
    },
  },
  {
    id: "unicode-nfc",
    category: "unicode",
    content: `See [[${"Cafe\u0301"}]] note.`,
    originalDestination: "Cafe\u0301",
    replacementDestination: "Café",
    destinationStart: 6,
    kind: "wiki",
    classification: "rewriteable",
    mustPreserve: ["[[", "]]"],
    notes: "NFC/NFD destination rewrite still preserves surrounding syntax.",
    planner: {
      operation: "rename",
      // Catalog titles resolve via casefold; use NFC so live wiki resolution hits.
      // NFD link text does not casefold-equal the NFC title, so replacement falls
      // back to the target basename token (current planner behavior).
      sourceRelPath: "cafe.md",
      sourceTitle: "Café",
      targetRelPath: "cafe-renamed.md",
      targetTitle: "Cafe Renamed",
      expectedProposedDestination: "cafe-renamed",
    },
  },
  {
    id: "percent-encoding",
    category: "encoding",
    content: "Go [here](old%20note.md#frag) end.",
    originalDestination: "old%20note.md",
    replacementDestination: "new%20note.md",
    destinationStart: 10,
    kind: "markdown",
    classification: "rewriteable",
    mustPreserve: ["#frag", "%20"],
    notes:
      "Only path destination token changes; fragment and encoding style kept.",
    planner: {
      operation: "rename",
      sourceRelPath: "old note.md",
      sourceTitle: "Old Note",
      targetRelPath: "new note.md",
      targetTitle: "New Note",
      expectedProposedDestination: "new%20note.md",
    },
  },
  {
    id: "fenced-code-opaque",
    category: "fenced-code",
    content: "```md\n[[Old Note]]\n```\n",
    originalDestination: "Old Note",
    replacementDestination: "New Note",
    destinationStart: 8,
    kind: "opaque",
    classification: "unchanged",
    reasonCode: "code_fence_context",
    mustPreserve: ["```md\n[[Old Note]]\n```"],
    notes: "Fenced code remains unchanged and reported as such.",
    planner: renameOldNote,
  },
  {
    id: "inline-code-opaque",
    category: "inline-code",
    content: "Use `[[Old Note]]` inline.",
    originalDestination: "Old Note",
    replacementDestination: "New Note",
    destinationStart: 7,
    kind: "opaque",
    classification: "unchanged",
    reasonCode: "inline_code_context",
    mustPreserve: ["`[[Old Note]]`"],
    notes: "Inline code spans are never rewritten.",
    planner: renameOldNote,
  },
  {
    id: "html-anchor-opaque",
    category: "html",
    content: '<a href="old-note.md">Old</a>',
    originalDestination: "old-note.md",
    replacementDestination: "new-note.md",
    destinationStart: 9,
    kind: "opaque",
    classification: "unsupported",
    reasonCode: "html_context",
    mustPreserve: ['<a href="old-note.md">Old</a>'],
    notes: "Raw HTML href is unsupported and left unchanged.",
    planner: renameOldNote,
  },
  {
    id: "malformed-wiki",
    category: "malformed",
    content: "Broken [[Old Note|alias",
    originalDestination: "Old Note",
    replacementDestination: "New Note",
    destinationStart: 9,
    kind: "opaque",
    classification: "malformed",
    reasonCode: "malformed_syntax",
    mustPreserve: ["[[Old Note|alias"],
    notes: "Unclosed wiki syntax is malformed and blocking.",
    planner: renameOldNote,
  },
  {
    id: "obsidian-embed-unsupported",
    category: "unsupported-obsidian",
    content: "![[Old Note]]",
    originalDestination: "Old Note",
    replacementDestination: "New Note",
    destinationStart: 3,
    kind: "opaque",
    classification: "unsupported",
    reasonCode: "unsupported_syntax",
    mustPreserve: ["![[Old Note]]"],
    notes: "Obsidian embed syntax is unsupported in the first release.",
    planner: renameOldNote,
  },
  {
    id: "external-url-unchanged",
    category: "external",
    content: "See [docs](https://example.com/old-note.md).",
    originalDestination: "https://example.com/old-note.md",
    replacementDestination: "https://example.com/old-note.md",
    destinationStart: 11,
    kind: "markdown",
    classification: "unchanged",
    reasonCode: "external_destination",
    mustPreserve: ["https://example.com/old-note.md"],
    notes: "External URLs are examined and left unchanged.",
    planner: renameOldNote,
  },
];

export const FILE_REFACTOR_FIXTURE_CATEGORIES = [
  "alias",
  "fragment",
  "label-title",
  "reference-definition",
  "relative-path",
  "angle-destination",
  "escaping",
  "duplicate-names",
  "unicode",
  "encoding",
  "fenced-code",
  "inline-code",
  "html",
  "malformed",
  "unsupported-obsidian",
  "external",
] as const;
