import { ConversionResult, GeneratorConfig, OfficeParserAST, SupportedDestination, SupportedFileType, UniversalGeneratorFormat } from './types.js';
/**
 * Main generator class providing document conversion functionality.
 */
export declare class OfficeGenerator {
    /**
     * Normalizes format aliases (e.g., 'txt' to 'text', 'markdown' to 'md') to standard internal formats.
     */
    static normalizeDestination(dest: string): UniversalGeneratorFormat;
    /**
     * Generates a file of the specified type from an AST.
     * This is the single source of truth for generation logic.
     *
     * @param ast - The OfficeParserAST to generate from
     * @param destination - The target format (e.g., 'text', 'md', 'html', 'pdf')
     * @param config - Optional configuration for the generator
     * @returns A promise resolving to the ConversionResult containing the value and messages
     * @throws {Error} If the destination format is unsupported
     */
    static generate<T extends SupportedFileType, D extends SupportedDestination<T>>(ast: OfficeParserAST & {
        type: T;
    }, destination: D, config?: GeneratorConfig<D>): Promise<ConversionResult<D>>;
}
