/**
 * Routing for the markitdown-ts adapter, kept apart from the adapter so the
 * registry can route files without loading pdf.js and the Office parsers.
 */

export const MARKITDOWN_CONVERTER_ID = "adapter/markitdown-ts" as const;

/** Supported extensions for this adapter */
const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".xlsx"];

/** Supported MIME types */
const SUPPORTED_MIMES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

export function markitdownCanHandle(mime: string, ext: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(ext) || SUPPORTED_MIMES.includes(mime);
}
