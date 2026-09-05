/**
 * Date Parsing Utilities
 *
 * Provides robust functions for parsing date strings from various office formats.
 * Handles standard ISO dates, PDF-specific date formats, and malformed strings.
 *
 * @module dateUtils
 */
/**
 * Parses a date string into a Date object.
 * Handles standard ISO formats and falls back to native parsing.
 * Returns undefined instead of "Invalid Date" if parsing fails.
 *
 * @param dateString - The date string to parse
 * @returns Parsed Date object or undefined if parsing fails
 */
export declare function parseOfficeDate(dateString: string | undefined): Date | undefined;
