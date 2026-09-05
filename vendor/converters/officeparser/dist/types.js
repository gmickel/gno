"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OfficeWarningType = exports.OfficeErrorType = void 0;
/**
 * Standard error types for OfficeParser.
 * Use these to identify the kind of error being reported.
 */
var OfficeErrorType;
(function (OfficeErrorType) {
    /** Unsupported file extension */
    OfficeErrorType["EXTENSION_UNSUPPORTED"] = "EXTENSION_UNSUPPORTED";
    /** Unsupported output generator format */
    OfficeErrorType["FORMAT_UNSUPPORTED"] = "FORMAT_UNSUPPORTED";
    /** File appears to be corrupted or malformed */
    OfficeErrorType["FILE_CORRUPTED"] = "FILE_CORRUPTED";
    /** File could not be found at the specified path */
    OfficeErrorType["FILE_DOES_NOT_EXIST"] = "FILE_DOES_NOT_EXIST";
    /** Specified location/directory is not reachable or is a directory */
    OfficeErrorType["LOCATION_NOT_FOUND"] = "LOCATION_NOT_FOUND";
    /** Arguments passed to the function are missing or invalid */
    OfficeErrorType["IMPROPER_ARGUMENTS"] = "IMPROPER_ARGUMENTS";
    /** Error occurred while reading or processing file buffers */
    OfficeErrorType["IMPROPER_BUFFERS"] = "IMPROPER_BUFFERS";
    /** Input type is not a supported type (string, Buffer, ArrayBuffer, Uint8Array) */
    OfficeErrorType["INVALID_INPUT"] = "INVALID_INPUT";
    /** PDF worker source is missing (required in browser) */
    OfficeErrorType["PDF_WORKER_MISSING"] = "PDF_WORKER_MISSING";
    /** Attempted to use Node.js-only features in a browser environment */
    OfficeErrorType["FEATURE_NOT_SUPPORTED_IN_BROWSER"] = "FEATURE_NOT_SUPPORTED_IN_BROWSER";
    /** Style mapping string is malformed */
    OfficeErrorType["INVALID_STYLE_MAPPING"] = "INVALID_STYLE_MAPPING";
    /** Selector in style mapping is invalid */
    OfficeErrorType["INVALID_SELECTOR"] = "INVALID_SELECTOR";
    /** Output mapping in style mapping is invalid */
    OfficeErrorType["INVALID_OUTPUT_MAPPING"] = "INVALID_OUTPUT_MAPPING";
    /** Semantic chunking strategy is selected but no embedding function is provided */
    OfficeErrorType["MISSING_EMBEDDING_FUNCTION"] = "MISSING_EMBEDDING_FUNCTION";
    /** The operation was aborted */
    OfficeErrorType["OPERATION_ABORTED"] = "OPERATION_ABORTED";
    /** ZIP entry count exceeds limit */
    OfficeErrorType["ZIP_ENTRY_COUNT_LIMIT_EXCEEDED"] = "ZIP_ENTRY_COUNT_LIMIT_EXCEEDED";
    /** ZIP entry missing a valid declared size */
    OfficeErrorType["ZIP_ENTRY_INVALID_SIZE"] = "ZIP_ENTRY_INVALID_SIZE";
    /** ZIP uncompressed size limit exceeded */
    OfficeErrorType["ZIP_SIZE_LIMIT_EXCEEDED"] = "ZIP_SIZE_LIMIT_EXCEEDED";
    /** ZIP data yielded no readable entries (corrupt, truncated, or not a ZIP archive) */
    OfficeErrorType["ZIP_NO_ENTRIES_FOUND"] = "ZIP_NO_ENTRIES_FOUND";
    /** ZIP data is truncated: the End of Central Directory record is absent */
    OfficeErrorType["ZIP_TRUNCATED"] = "ZIP_TRUNCATED";
    /** A readable ZIP archive is missing the part its document format requires */
    OfficeErrorType["REQUIRED_PART_MISSING"] = "REQUIRED_PART_MISSING";
    /** Document element/structure nesting exceeded the safe recursion depth */
    OfficeErrorType["MAX_NESTING_DEPTH_EXCEEDED"] = "MAX_NESTING_DEPTH_EXCEEDED";
    /** Embedding call timed out */
    OfficeErrorType["EMBEDDING_TIMEOUT"] = "EMBEDDING_TIMEOUT";
})(OfficeErrorType || (exports.OfficeErrorType = OfficeErrorType = {}));
/**
 * Standard warning types for OfficeParser.
 * Use these for reporting non-fatal issues or performance tips.
 */
var OfficeWarningType;
(function (OfficeWarningType) {
    /** Performance advice (e.g., Rosetta translation on Mac) */
    OfficeWarningType["PERFORMANCE_TIP"] = "PERFORMANCE_TIP";
    /** OCR processing failed for an attachment */
    OfficeWarningType["OCR_FAILED"] = "OCR_FAILED";
    /** Extraction of structured chart data failed */
    OfficeWarningType["CHART_DATA_EXTRACTION_FAILED"] = "CHART_DATA_EXTRACTION_FAILED";
    /** Automatic worker path failed, falling back to CDN */
    OfficeWarningType["PDF_WORKER_FALLBACK"] = "PDF_WORKER_FALLBACK";
    /** General attachment extraction failure */
    OfficeWarningType["ATTACHMENT_EXTRACTION_FAILED"] = "ATTACHMENT_EXTRACTION_FAILED";
    /** Failed to load a specific page in a multi-page document */
    OfficeWarningType["PAGE_LOAD_FAILED"] = "PAGE_LOAD_FAILED";
    /** Failed to load a required dynamic dependency */
    OfficeWarningType["DEPENDENCY_LOAD_FAILED"] = "DEPENDENCY_LOAD_FAILED";
    /** Failed to extract images from a source */
    OfficeWarningType["IMAGE_EXTRACTION_FAILED"] = "IMAGE_EXTRACTION_FAILED";
    /** Failed to extract annotations from a document */
    OfficeWarningType["ANNOTATION_EXTRACTION_FAILED"] = "ANNOTATION_EXTRACTION_FAILED";
    /** Failed to process an extracted image bitmap */
    OfficeWarningType["IMAGE_PROCESSING_FAILED"] = "IMAGE_PROCESSING_FAILED";
    /** Warning about limitations of browser-based generation */
    OfficeWarningType["BROWSER_GENERATION_LIMITATION"] = "BROWSER_GENERATION_LIMITATION";
    /** Specified sheet range in Excel/ODS export was not found */
    OfficeWarningType["SHEET_RANGE_NOT_FOUND"] = "SHEET_RANGE_NOT_FOUND";
    /** Buffer content type does not match the provided or expected file extension */
    OfficeWarningType["BUFFER_TYPE_MISMATCH"] = "BUFFER_TYPE_MISMATCH";
    /** Failed to detect file type from buffer due to library error or incompatibility */
    OfficeWarningType["FILE_TYPE_DETECTION_FAILED"] = "FILE_TYPE_DETECTION_FAILED";
    /** No chunks were generated for the document given the current strategy */
    OfficeWarningType["EMPTY_CHUNK_GENERATED"] = "EMPTY_CHUNK_GENERATED";
    /** A node was skipped because it only contained whitespace */
    OfficeWarningType["WHITESPACE_NODE_SKIPPED"] = "WHITESPACE_NODE_SKIPPED";
    /** The HTML generator containerWidth option is invalid */
    OfficeWarningType["INVALID_CONTAINER_WIDTH"] = "INVALID_CONTAINER_WIDTH";
    /** A document's repeated-cell expansion hit the configured cell limit and was truncated */
    OfficeWarningType["TABLE_CELL_LIMIT_EXCEEDED"] = "TABLE_CELL_LIMIT_EXCEEDED";
    /** A metadata override could not be represented in the destination format's vocabulary */
    OfficeWarningType["METADATA_NOT_REPRESENTABLE"] = "METADATA_NOT_REPRESENTABLE";
    /** A styleMap output.tag was not an allowed element name and was ignored */
    OfficeWarningType["INVALID_STYLE_MAP_TAG"] = "INVALID_STYLE_MAP_TAG";
    /** A workbook archive contains no worksheet parts (chartsheet-only workbooks are legitimate) */
    OfficeWarningType["NO_WORKSHEETS_FOUND"] = "NO_WORKSHEETS_FOUND";
    /** A presentation archive contains no slides (a zero-slide presentation is legitimate) */
    OfficeWarningType["NO_SLIDES_FOUND"] = "NO_SLIDES_FOUND";
})(OfficeWarningType || (exports.OfficeWarningType = OfficeWarningType = {}));
