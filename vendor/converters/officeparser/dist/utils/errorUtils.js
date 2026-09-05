"use strict";
/**
 * Error Handling Utilities
 *
 * This module provides centralized error management for the OfficeParser library.
 * It defines standard error types, messages, and handling logic to ensure
 * consistent error reporting across all parsers and the main entry point.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkAbortSignal = exports.getAbortError = exports.logWarning = exports.getWrappedError = exports.getOfficeError = exports.getWarningMessage = void 0;
const types_js_1 = require("../types.js");
/** Error header prefix for all error messages */
const ERRORHEADER = "[OfficeParser]: ";
// `OfficeError` (the public shape callers catch) lives in types.ts alongside `OfficeIssue`.
// Every error built by getOfficeError is branded with its issue, which serves two purposes:
// consumers branch on `err.officeIssue.code` instead of matching message text, and
// getWrappedError recognizes an error it has already reported and prefixed, so it neither
// reports it twice nor prepends a second header.
/**
 * Lookup table for error messages.
 * Some entries are functions that take parameters to build dynamic messages.
 */
const ERROR_MESSAGES = {
    [types_js_1.OfficeErrorType.EXTENSION_UNSUPPORTED]: (ext) => `Sorry, OfficeParser currently supports docx, pptx, xlsx, odt, odp, ods, pdf, rtf, md, html, csv, epub files only. Create a ticket in Issues on github to add support for ${ext} files. Stay tuned for further updates.`,
    [types_js_1.OfficeErrorType.FORMAT_UNSUPPORTED]: (format) => `Sorry, OfficeGenerator does not support generating '${format}' files. Supported formats: json, text, md, html, csv, rtf, pdf, chunks, epub.`,
    [types_js_1.OfficeErrorType.FILE_CORRUPTED]: (filepath) => `Your file ${filepath} seems to be corrupted. If you are sure it is fine, please create a ticket in Issues on github with the file to reproduce error.`,
    [types_js_1.OfficeErrorType.FILE_DOES_NOT_EXIST]: (filepath) => `File ${filepath} could not be found! Check if the file exists or verify if the relative path to the file is correct from your terminal's location.`,
    [types_js_1.OfficeErrorType.LOCATION_NOT_FOUND]: (location) => `Entered location ${location} is not reachable! Please make sure that the entered directory location exists. Check relative paths and reenter.`,
    [types_js_1.OfficeErrorType.IMPROPER_ARGUMENTS]: `Improper arguments`,
    [types_js_1.OfficeErrorType.IMPROPER_BUFFERS]: `Auto-detection of file type from buffer failed. This can happen if the format lacks magic bytes (like md, html, or csv) or if the detection library is incompatible with your Node.js version. Please provide the 'fileType' hint in your configuration (e.g., { fileType: 'docx' }) to proceed.`,
    [types_js_1.OfficeErrorType.INVALID_INPUT]: `Invalid input type: Expected a Buffer or a valid file path`,
    [types_js_1.OfficeErrorType.PDF_WORKER_MISSING]: `Missing PDF worker configuration. PDF parsing in browser environments requires a worker source. Please provide "pdfWorkerSrc" in your configuration.`,
    [types_js_1.OfficeErrorType.FEATURE_NOT_SUPPORTED_IN_BROWSER]: (feature) => `'${feature}' is not supported in the browser. Browser users must pass file content as Buffer or ArrayBuffer directly.`,
    [types_js_1.OfficeErrorType.INVALID_STYLE_MAPPING]: (mapping) => `Invalid style mapping string: ${mapping}`,
    [types_js_1.OfficeErrorType.INVALID_SELECTOR]: (selector) => `Invalid selector: ${selector}`,
    [types_js_1.OfficeErrorType.INVALID_OUTPUT_MAPPING]: (output) => `Invalid output mapping: ${output}`,
    [types_js_1.OfficeErrorType.MISSING_EMBEDDING_FUNCTION]: `Semantic chunking requires an "embeddingFunction" to be provided in chunksConfig. This function must accept a string and return a Promise resolving to a number array (vector).`,
    [types_js_1.OfficeErrorType.OPERATION_ABORTED]: `The operation was aborted.`,
    [types_js_1.OfficeErrorType.ZIP_ENTRY_COUNT_LIMIT_EXCEEDED]: (limit) => `ZIP entry count exceeds limit (${limit})`,
    [types_js_1.OfficeErrorType.ZIP_ENTRY_INVALID_SIZE]: `ZIP entry missing a valid declared size`,
    [types_js_1.OfficeErrorType.ZIP_SIZE_LIMIT_EXCEEDED]: (limit) => `ZIP uncompressed size limit exceeded (${limit} bytes)`,
    [types_js_1.OfficeErrorType.ZIP_NO_ENTRIES_FOUND]: `No readable entries found in ZIP data. The input is corrupt, truncated, or not a ZIP archive: every ZIP-based document format requires at least one entry.`,
    [types_js_1.OfficeErrorType.ZIP_TRUNCATED]: `Malformed ZIP data: no End of Central Directory record was found at the end of the input. Either the file was cut off during download or transfer, or extra data follows the archive; in both cases the entries recovered from it cannot be trusted to be the whole document.`,
    [types_js_1.OfficeErrorType.REQUIRED_PART_MISSING]: (info) => `Your ${info.fileType} file is a readable ZIP archive but is missing its required '${info.part}' part, so it cannot be a valid ${info.fileType} document. The file is corrupt, incomplete, or mislabeled. If you are sure it is fine, please create a ticket in Issues on github with the file to reproduce the error.`,
    [types_js_1.OfficeErrorType.MAX_NESTING_DEPTH_EXCEEDED]: `Document nesting depth exceeded the safe limit (possible denial-of-service input)`,
    [types_js_1.OfficeErrorType.EMBEDDING_TIMEOUT]: (timeout) => `Embedding call timed out after ${timeout}ms`
};
/**
 * Lookup table for warning messages.
 */
const WARNING_MESSAGES = {
    [types_js_1.OfficeWarningType.PERFORMANCE_TIP]: (tip) => `⚡️ Performance Tip: ${tip}`,
    [types_js_1.OfficeWarningType.OCR_FAILED]: (name) => `OCR failed for ${name}:`,
    [types_js_1.OfficeWarningType.CHART_DATA_EXTRACTION_FAILED]: (path) => `Failed to extract chart data from ${path}:`,
    [types_js_1.OfficeWarningType.PDF_WORKER_FALLBACK]: `Could not auto-resolve local worker path, falling back to CDN:`,
    [types_js_1.OfficeWarningType.ATTACHMENT_EXTRACTION_FAILED]: `Error extracting embedded attachments:`,
    [types_js_1.OfficeWarningType.PAGE_LOAD_FAILED]: (page) => `Error loading page ${page}:`,
    [types_js_1.OfficeWarningType.DEPENDENCY_LOAD_FAILED]: (dep) => `Failed to load dependency ${dep}:`,
    [types_js_1.OfficeWarningType.IMAGE_EXTRACTION_FAILED]: (context) => `Error extracting images ${context}:`,
    [types_js_1.OfficeWarningType.ANNOTATION_EXTRACTION_FAILED]: (page) => `Error extracting annotations from page ${page}:`,
    [types_js_1.OfficeWarningType.IMAGE_PROCESSING_FAILED]: `Failed to extract from ImageBitmap:`,
    [types_js_1.OfficeWarningType.BROWSER_GENERATION_LIMITATION]: (msg) => msg,
    [types_js_1.OfficeWarningType.SHEET_RANGE_NOT_FOUND]: (range) => `No sheets found matching the range: ${range}`,
    [types_js_1.OfficeWarningType.BUFFER_TYPE_MISMATCH]: (info) => `File content type mismatch: Detected '${info.detected}' but expected/provided '${info.expected}'. Parsing will proceed with '${info.expected}' as requested.`,
    [types_js_1.OfficeWarningType.FILE_TYPE_DETECTION_FAILED]: `Auto-detection of file type failed. This can happen on older Node.js versions with modern file-type versions. Please provide the 'fileType' hint in the configuration if parsing fails.`,
    [types_js_1.OfficeWarningType.EMPTY_CHUNK_GENERATED]: (strategy) => `No chunks generated for document. Check if the document content is compatible with the '${strategy}' strategy.`,
    [types_js_1.OfficeWarningType.WHITESPACE_NODE_SKIPPED]: (nodeType) => `Skipped whitespace-only node of type: ${nodeType}`,
    [types_js_1.OfficeWarningType.TABLE_CELL_LIMIT_EXCEEDED]: (limit) => `Table cell limit (${limit}) reached while expanding repeated ODF cells/rows; the remaining cells were not materialized. A few hundred bytes of XML can request an unbounded number of cells via table:number-columns-repeated / table:number-rows-repeated, so this is capped. Raise decompressionLimits.maxTableCells if your documents legitimately exceed it.`,
    [types_js_1.OfficeWarningType.INVALID_CONTAINER_WIDTH]: (val) => `Invalid HTML containerWidth: ${JSON.stringify(val)}. Falling back to "auto". Width must be a positive number, a valid CSS length string (e.g., "900px", "100%", "50vw"), or "auto".`,
    [types_js_1.OfficeWarningType.METADATA_NOT_REPRESENTABLE]: (info) => `Custom metadata ${info.keys.map(k => `'${k}'`).join(', ')} could not be written to ${info.format} output: the format has a fixed metadata vocabulary with no place for caller-defined keys. The named metadata fields (title, author, etc.) were still applied.`,
    [types_js_1.OfficeWarningType.NO_WORKSHEETS_FOUND]: `Workbook contains no worksheet parts (xl/worksheets/). If the workbook holds only chartsheets this is expected and there is simply no cell text to extract; otherwise the file may be incomplete.`,
    [types_js_1.OfficeWarningType.NO_SLIDES_FOUND]: `Presentation contains no slides (ppt/slides/). A legitimately empty presentation produces this too, but if you expected content the file may be incomplete.`,
    [types_js_1.OfficeWarningType.INVALID_STYLE_MAP_TAG]: (tag) => `styleMap output.tag ${JSON.stringify(tag)} is not an allowed element name and was ignored; the node's default tag was used instead. A tag name is written into both the opening and closing tag, so only a known-safe set of block, heading and inline elements is accepted.`
};
/**
 * Creates a formatted warning message for a specific warning type.
 *
 * @param type - The type of warning
 * @param info - Optional additional information
 * @returns The formatted warning message string
 */
const getWarningMessage = (type, info) => {
    const msg = WARNING_MESSAGES[type];
    const message = typeof msg === 'function' ? msg(info) : msg;
    return message;
};
exports.getWarningMessage = getWarningMessage;
/**
 * Creates a formatted error message for a specific error type.
 *
 * @param type - The type of error
 * @param info - Optional additional information (e.g., filepath, extension)
 * @returns The formatted error message string
 */
const createOfficeError = (type, info) => {
    const msg = ERROR_MESSAGES[type];
    const message = typeof msg === 'function' ? msg(info) : msg;
    return message;
};
/**
 * Core reporting logic for all issues.
 * Ensures consistent logging and callback execution.
 */
const reportIssue = (issue, config) => {
    if (config?.onWarning) {
        config.onWarning(issue);
    }
    else if (!config || config.outputErrorToConsole) {
        const formatted = ERRORHEADER + issue.message;
        if (issue.type === 'error') {
            console.error(formatted, issue.details || '');
        }
        else {
            console.warn(formatted, issue.details || '');
        }
    }
};
/**
 * Creates, optionally logs to console, and returns a formatted OfficeParser error.
 *
 * @param type - The type of error
 * @param config - Optional parser configuration (checks outputErrorToConsole)
 * @param info - Optional additional information
 * @returns The Error object to be thrown
 */
const getOfficeError = (type, config, info) => {
    const message = createOfficeError(type, info);
    const issue = {
        type: 'error',
        code: type,
        message,
        details: info
    };
    reportIssue(issue, config);
    const error = new Error(ERRORHEADER + message);
    // Brand the error with the issue that produced it so getWrappedError can tell an
    // already-reported, already-prefixed OfficeParser error from a raw third-party one.
    error.officeIssue = issue;
    return error;
};
exports.getOfficeError = getOfficeError;
/**
 * Wraps an existing error with OfficeParser context and performs corruption detection.
 * Optionally logs the error to console.
 *
 * An error already built by {@link getOfficeError} is returned untouched: it carries an
 * `officeIssue`, meaning it has been reported once and already bears the `[OfficeParser]: `
 * header. Re-wrapping it would report the same issue a second time, prepend a second header,
 * and flatten its specific error code to `FILE_CORRUPTED`. This is a marker check on the error
 * object rather than a test against its message text, so it stays independent of wording.
 *
 * **Important**: Do NOT pass AbortErrors to this function. AbortErrors (err.name === 'AbortError')
 * represent deliberate user cancellation and must be re-thrown as-is from the catch block so that
 * callers can reliably detect them via `err.name === 'AbortError'` or `err instanceof DOMException`.
 * This function always returns a plain `new Error(...)`, which would strip the AbortError identity.
 *
 * @param error - The original error object
 * @param config - Parser configuration
 * @param filePath - Optional file path for context
 * @returns The wrapped Error object to be thrown
 */
const getWrappedError = (error, config, filePath) => {
    if (error?.officeIssue)
        return error;
    let message = error.message || error;
    let code = types_js_1.OfficeErrorType.FILE_CORRUPTED; // Default for wrapped errors
    // Detect file corruption from common library error messages
    if (filePath && (message.includes('end of central directory record') ||
        message.includes('invalid XML') ||
        message.includes('Failed to open zip file') ||
        message.includes('invalid distance too far back'))) {
        message = createOfficeError(types_js_1.OfficeErrorType.FILE_CORRUPTED, filePath);
    }
    const issue = {
        type: 'error',
        code: types_js_1.OfficeErrorType.FILE_CORRUPTED,
        message,
        details: filePath ? { filePath, originalError: error } : error
    };
    reportIssue(issue, config);
    return new Error(ERRORHEADER + message);
};
exports.getWrappedError = getWrappedError;
/**
 * Centralized logging utility for non-fatal warnings or issues.
 * Routes messages to config.onWarning if provided, or console.warn/error
 * if config.outputErrorToConsole is true.
 *
 * @param messageOrType - The warning message or warning type
 * @param config - Optional parser configuration
 * @param info - Optional additional information for dynamic messages or context
 * @param error - Optional original error object
 */
const logWarning = (type, config, info, error) => {
    let message;
    let details = info;
    const msg = WARNING_MESSAGES[type];
    if (typeof msg === 'function') {
        message = msg(info);
        details = error || info;
    }
    else {
        message = msg;
        if (info instanceof Error && !error) {
            details = info;
        }
    }
    const issue = {
        type: 'warning',
        code: type,
        message,
        details
    };
    reportIssue(issue, config);
};
exports.logWarning = logWarning;
/**
 * Creates and returns a standard AbortError (DOMException if available).
 * Used when the user signals cancellation of the parser operation.
 *
 * @returns Error object representing the abort action
 */
const getAbortError = () => {
    const message = ERROR_MESSAGES[types_js_1.OfficeErrorType.OPERATION_ABORTED];
    if (typeof DOMException !== 'undefined') {
        return new DOMException(message, 'AbortError');
    }
    const err = new Error(message);
    err.name = 'AbortError';
    return err;
};
exports.getAbortError = getAbortError;
/**
 * Checks the provided AbortSignal and throws an AbortError if it was aborted.
 * Helps cleanly interrupt loops and asynchronous phases of parsing.
 *
 * @param signal - Optional AbortSignal to inspect
 * @throws {DOMException} If the signal has been aborted
 */
const checkAbortSignal = (signal) => {
    if (signal?.aborted) {
        throw (0, exports.getAbortError)();
    }
};
exports.checkAbortSignal = checkAbortSignal;
