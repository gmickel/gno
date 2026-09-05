import { ConversionResult, GeneratorConfig, OfficeParserAST } from '../types.js';
import { BaseGenerator } from './BaseGenerator.js';
/**
 * Generates plain text from an AST.
 */
export declare class TextGenerator extends BaseGenerator<'text'> {
    constructor(ast: OfficeParserAST, config?: GeneratorConfig<'text'>);
    /**
     * Generates plain text by concatenating text content from nodes.
     */
    generate(): Promise<ConversionResult<'text'>>;
    private renderTable;
}
