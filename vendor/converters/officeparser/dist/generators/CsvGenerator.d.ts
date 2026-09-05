import { ConversionResult, GeneratorConfig, OfficeParserAST } from '../types.js';
import { BaseGenerator } from './BaseGenerator.js';
/**
 * Generates CSV files from an AST.
 */
export declare class CsvGenerator extends BaseGenerator<'csv'> {
    constructor(ast: OfficeParserAST, config?: GeneratorConfig<'csv'>);
    /**
     * Generates CSV content from the provided AST.
     *
     * @returns A CSV string or a ZIP archive containing multiple CSVs
     */
    generate(): Promise<ConversionResult<'csv'>>;
    /**
     * Recursively finds all nodes that can be treated as sheets (sheet or table).
     */
    private collectSheetLikeNodes;
    /**
     * Renders a sheet or table node to raw row data.
     */
    private renderNodeToRows;
    /**
     * Escapes a value for CSV formatting: RFC 4180 quoting plus a spreadsheet
     * formula-injection guard (see csvSafeCell in ../utils/sanitize.js).
     */
    private escapeCsvValue;
    /** Sanitizes a value for a `#` comment line (document metadata or sheet name).
     *  Comment lines are free text prefixed with `#`, not RFC-4180 cells, so they
     *  can't be quoted; instead we (a) collapse newlines so the value can't break out
     *  and inject a new row, and (b) replace the column delimiter with a space so a
     *  value like `x,=1+1` can't split into a second cell that a spreadsheet would
     *  evaluate as a formula (CSV formula/DDE injection). */
    private sanitizeComment;
    /**
     * Renders metadata as comments.
     */
    private renderMetadata;
}
