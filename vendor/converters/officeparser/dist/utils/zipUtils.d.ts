/**
 * ZIP Archive Extraction Utilities
 *
 * Provides functions for extracting files from ZIP archives.
 * Essential for parsing OOXML (DOCX, XLSX, PPTX) and ODF (ODT, ODP, ODS) files,
 * which are all ZIP archives containing XML and media files.
 *
 * Office File Structure:
 * - DOCX: ZIP containing word/document.xml, word/styles.xml, word/media/*, etc.
 * - XLSX: ZIP containing xl/workbook.xml, xl/worksheets/sheet1.xml, etc.
 * - PPTX: ZIP containing ppt/slides/slide1.xml, ppt/media/*, etc.
 * - ODF: Similar structure with content.xml, styles.xml, etc.
 *
 * @module zipUtils
 */
import { DecompressionLimits, OfficeParserConfig, SupportedFileType } from '../types.js';
/**
 * Represents a file extracted from a ZIP archive.
 * Contains the file's path within the archive and its content as a Buffer.
 */
export interface ZipFileContent {
    /**
     * The relative path of the file within the ZIP archive.
     * @example "word/document.xml", "xl/worksheets/sheet1.xml", "ppt/slides/slide1.xml"
     */
    path: string;
    /**
     * The file content as a Node.js Buffer.
     * Can be converted to string for XML files or used directly for binary files (images, etc.).
     * @example Buffer containing XML text or binary image data
     */
    content: Buffer;
}
/**
 * Extracts files from a ZIP archive with optional filtering.
 *
 * This function:
 * 1. Opens the ZIP archive from a Buffer
 * 2. Iterates through all entries in the archive
 * 3. Applies a filter function to determine which files to extract
 * 4. Extracts matching files and returns them as an array
 *
 * Uses lazy entry reading for better memory efficiency with large archives.
 * Files are extracted asynchronously and collected into an array.
 *
 * @param zipInput - The ZIP file as a Node.js Buffer
 * @param filterFn - A predicate function to determine which files to extract.
 *                   Receives the filename and returns true to extract, false to skip.
 * @param limits - Decompression limits guarding against zip bombs
 * @param config - Parser configuration, so extraction failures honour `onWarning` /
 *                 `outputErrorToConsole` like every other reported issue
 * @returns A promise resolving to an array of extracted files
 * @throws {Error} If the ZIP file cannot be opened or an entry cannot be read
 *
 * @example
 * ```typescript
 * // Extract only XML files from a DOCX
 * const files = await extractFiles(docxBuffer, (fileName) => fileName.endsWith('.xml'));
 *
 * // Extract document.xml specifically
 * const files = await extractFiles(docxBuffer, (fileName) =>
 *   fileName === 'word/document.xml'
 * );
 *
 * // Extract all files
 * const allFiles = await extractFiles(zipBuffer, () => true);
 *
 * // Extract everything except media files
 * const files = await extractFiles(zipBuffer, (fileName) =>
 *   !fileName.startsWith('word/media/')
 * );
 * ```
 *
 * @see https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT ZIP file format specification
 */
export declare const extractFiles: (zipInput: Buffer, filterFn: (fileName: string) => boolean, limits: DecompressionLimits, config?: OfficeParserConfig) => Promise<ZipFileContent[]>;
/**
 * Finds the archive part that every document of a given format must contain, and fails loudly
 * when it is absent.
 *
 * A readable ZIP archive is not by itself a document: an archive can decompress perfectly and
 * still be a renamed photo bundle, a partial upload, or a file mislabeled with the wrong
 * extension. Without this check a parser finds no content to walk and returns an empty AST,
 * which a caller cannot distinguish from a document that genuinely has nothing in it. Every
 * ZIP-backed format has one part it cannot be valid without, so its absence is a hard error.
 *
 * Pass the parser's own regex/predicate for the part rather than a fresh copy of the path, so
 * this check and the code that later reads the part cannot drift apart.
 *
 * @param files - The entries extracted from the archive
 * @param matcher - Predicate identifying the required part by its path within the archive
 * @param config - Parser configuration, so the error is reported through the caller's handlers
 * @param info - The document format and the human-readable part name, used in the message
 * @returns The matching entry
 * @throws {Error} A typed REQUIRED_PART_MISSING error when no entry matches
 *
 * @example
 * ```typescript
 * const document = findRequiredPart(files, p => !!p.match(documentFileRegex), config,
 *     { fileType: 'docx', part: 'word/document.xml' });
 * ```
 */
export declare const findRequiredPart: (files: ZipFileContent[], matcher: (path: string) => boolean, config: OfficeParserConfig, info: {
    fileType: string;
    part: string;
}) => ZipFileContent;
/**
 * Resolves which office format a ZIP archive actually holds, by reading the part that names it.
 *
 * This exists because magic-byte sniffing is a heuristic that gives up. `file-type` identifies an
 * OOXML package by parsing `[Content_Types].xml`, but it walks the archive under fixed budgets:
 * at most 1024 entries, and (for entries whose sizes are deferred to a trailing data descriptor,
 * general-purpose flag bit 3) about 1 MiB of scanning to locate those descriptors. An archive
 * that puts enough data before `[Content_Types].xml` to exhaust either budget is reported as a
 * generic `zip`, which previously surfaced to the caller as "add support for zip files" for a
 * perfectly valid document. Both layouts occur in the wild: streaming ZIP writers set bit 3, and
 * a media-heavy deck can hold more than 1024 parts.
 *
 * We already ship a ZIP reader that has neither limitation, so rather than guessing from the
 * first bytes this opens the archive and reads the declaration directly. It is deliberately the
 * fallback rather than the primary check, since the byte-level sniff is far cheaper and settles
 * every non-ZIP format.
 *
 * @param zipInput - The candidate archive
 * @param limits - Decompression limits, so sniffing an untrusted file stays bounded
 * @returns The format the archive declares, or `undefined` if it declares none or cannot be read
 *
 * @example
 * ```typescript
 * // A presentation whose [Content_Types].xml sits behind 2 MiB of streamed entries
 * await detectOfficeTypeFromZip(buffer, limits); // -> 'pptx'
 * ```
 */
export declare const detectOfficeTypeFromZip: (zipInput: Buffer, limits: DecompressionLimits) => Promise<SupportedFileType | undefined>;
