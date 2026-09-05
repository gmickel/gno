#!/usr/bin/env node
/**
 * officeparser CLI
 *
 * Allows running officeparser from the command line:
 *   npx officeparser file.docx
 *   officeparser file.docx --to=text
 *   officeparser file.docx --ocr --extractAttachments
 *
 * Options (--key=value, --key value, or bare flags):
 *   --to=json|text|md|html|csv|rtf|pdf|epub|chunks  Convert AST to specified format (default: json)
 *   --output=path             Save result to a file
 *   --fileType=docx|xlsx|...  Override file type detection
 *   --ocr                     Enable OCR for images (default: false)
 *   --ocrConfig.language=eng  OCR language (default: eng)
 *   --extractAttachments      Extract embedded attachments (default: false)
 *   --ignoreNotes             Ignore footnotes/endnotes/speaker notes (default: false)
 *   --ignoreComments          Ignore inline comments (default: false)
 *   --ignoreHeadersAndFooters Ignore headers and footers (default: false)
 *   --ignoreSlideMasters      Ignore slide masters (default: false)
 *   --ignoreInternalLinks     Ignore internal links (default: false)
 *   --includeRawContent       Include raw content in AST (default: false)
 *   --serializeRawContent     Include stringified XML in metadata (default: true)
 *   --preserveXmlWhitespace   Keep raw formatting space (default: false)
 *   --includeBreakNodes       Include break nodes (DOCX only, default: false)
 *   --verbose                 Show full error stack traces and warning logs
 */
export {};
