import type {
  BrowserClipPayload,
  Destination,
  ExtractionResult,
} from "./types";

export interface PayloadDraft {
  mode: "selection" | "reader";
  authenticated: boolean;
  destination: Destination;
  tags: string[];
  note: string | null;
  editedMarkdown: string | null;
}

export const buildBrowserClipPayload = (
  extraction: ExtractionResult,
  draft: PayloadDraft
): BrowserClipPayload => {
  const warnings = new Set(extraction.warnings);
  if (draft.authenticated) warnings.add("authenticated_visible_content");
  if (draft.editedMarkdown !== null) warnings.add("edited_content");
  const common = {
    schemaVersion: "1.0" as const,
    sourceUrl: extraction.sourceUrl,
    canonicalUrl: extraction.canonicalUrl,
    title: extraction.title,
    author: extraction.author,
    site: extraction.site,
    publishedAt: extraction.publishedAt,
    observedAt: extraction.observedAt,
    browser: extraction.browser,
    extraction: {
      visibility: "user_visible" as const,
      authenticated: draft.authenticated,
      extractorVersion: "gno-browser-clipper/1.0",
      warnings: [...warnings],
    },
    destination: draft.destination,
    tags: draft.tags,
    note: draft.note,
  };

  if (draft.mode === "selection") {
    if (!extraction.selectionText) {
      throw new Error(
        "No top-frame selection found. Select visible text, then try again."
      );
    }
    return {
      ...common,
      mode: "selection",
      selection: {
        exactText: extraction.selectionText,
        editedMarkdown: draft.editedMarkdown,
      },
    };
  }
  if (extraction.readerBlocks.length === 0) {
    throw new Error("No supported visible Reader content was found.");
  }
  return {
    ...common,
    mode: "reader",
    reader: {
      blocks: extraction.readerBlocks,
      editedMarkdown: draft.editedMarkdown,
    },
  };
};
