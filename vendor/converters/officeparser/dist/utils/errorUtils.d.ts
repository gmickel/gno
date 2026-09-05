/**
 * Error Handling Utilities
 *
 * This module provides centralized error management for the OfficeParser library.
 * It defines standard error types, messages, and handling logic to ensure
 * consistent error reporting across all parsers and the main entry point.
 */
import { OfficeError, OfficeErrorType, OfficeParserConfig, OfficeWarningType } from '../types.js';
/**
 * Creates a formatted warning message for a specific warning type.
 *
 * @param type - The type of warning
 * @param info - Optional additional information
 * @returns The formatted warning message string
 */
export declare const getWarningMessage: (type: OfficeWarningType, info?: any) => string;
/**
 * Creates, optionally logs to console, and returns a formatted OfficeParser error.
 *
 * @param type - The type of error
 * @param config - Optional parser configuration (checks outputErrorToConsole)
 * @param info - Optional additional information
 * @returns The Error object to be thrown
 */
export declare const getOfficeError: (type: OfficeErrorType, config?: OfficeParserConfig, info?: any) => OfficeError;
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
export declare const getWrappedError: (error: any, config: OfficeParserConfig, filePath?: string) => Error;
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
export declare const logWarning: (type: OfficeWarningType, config?: OfficeParserConfig, info?: any, error?: any) => void;
/**
 * Creates and returns a standard AbortError (DOMException if available).
 * Used when the user signals cancellation of the parser operation.
 *
 * @returns Error object representing the abort action
 */
export declare const getAbortError: () => Error;
/**
 * Checks the provided AbortSignal and throws an AbortError if it was aborted.
 * Helps cleanly interrupt loops and asynchronous phases of parsing.
 *
 * @param signal - Optional AbortSignal to inspect
 * @throws {DOMException} If the signal has been aborted
 */
export declare const checkAbortSignal: (signal?: AbortSignal | null) => void;
