/**
 * Parses a range string (e.g., "1", "1-3", "1,2", "1,3-5, 7") into an array of numbers.
 *
 * @param rangeStr - The range string to parse
 * @returns An array of unique, sorted numbers (1-based indices)
 */
export declare function parseRangeString(rangeStr: string): number[];
