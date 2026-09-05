import { FullOfficeParserConfig, OfficeParserAST } from '../types.js';
/**
 * Parses a CSV file and extracts a single sheet with rows and cells.
 *
 * @param buffer - The CSV file as a Buffer
 * @param config - Parser configuration
 * @returns A promise resolving to the parsed AST
 */
export declare const parseCsv: (buffer: Buffer, config: FullOfficeParserConfig) => Promise<OfficeParserAST>;
