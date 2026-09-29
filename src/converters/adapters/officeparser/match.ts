/**
 * Routing for the officeparser adapter, kept apart from the adapter so the
 * registry can route files without loading the parser.
 */

export const OFFICEPARSER_CONVERTER_ID = "adapter/officeparser" as const;

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export function officeparserCanHandle(mime: string, ext: string): boolean {
  return ext === ".pptx" || mime === PPTX_MIME;
}
