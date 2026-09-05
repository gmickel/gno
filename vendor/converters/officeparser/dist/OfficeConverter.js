"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OfficeConverter = void 0;
const OfficeGenerator_js_1 = require("./OfficeGenerator.js");
const OfficeParser_js_1 = require("./OfficeParser.js");
/**
 * Main converter class providing a streamlined one-step API for document conversion.
 *
 * This class coordinates the `OfficeParser` and `OfficeGenerator` to transform
 * documents from one format to another (e.g., DOCX to Markdown, PDF to HTML).
 */
class OfficeConverter {
    /**
     * Converts an office document from its source format to a specified destination format.
     *
     * This method:
     * 1. Detects the source file type and parses it into a unified AST using `OfficeParser`.
     * 2. Automatically configures the parser based on the generator requirements (e.g., enabling
     *    attachment extraction if images are requested in the output).
     * 3. Generates the destination document from the AST using `OfficeGenerator`.
     *
     * @template F The inferred type of the input file (path string or buffer).
     * @template T The authoritative source file type (inferred from path or config).
     *
     * @param file - File path (string), Buffer, or ArrayBuffer containing the source document.
     * @param destination - The target format (e.g., 'md', 'html', 'pdf', 'text', 'chunks').
     * @param config - Optional unified configuration for both the parser and generator phases.
     *
     * @returns A promise resolving to the ConversionResult containing the value and messages.
     * @throws {Error} If the source format is unsupported or parsing/generation fails.
     *
     * @example
     * ```typescript
     * // Convert Word to Markdown with a single call
     * const { value: markdown } = await OfficeConverter.convert('report.docx', 'md');
     *
     * // Convert PDF to HTML (Note: OCR is disabled in this one-step API)
     * const { value: html } = await OfficeConverter.convert(buffer, 'html', {
     *   generatorConfig: {
     *     includeImages: true
     *   }
     * });
     * ```
     */
    static async convert(file, destination, config) {
        // 1. Prepare Parser Configuration
        // We prioritize the top-level onWarning if provided.
        const parserConfig = {
            ...config?.parseConfig,
            onWarning: config?.onWarning || config?.parseConfig?.onWarning,
        };
        // Remove OCR settings for the streamlined converter as requested
        parserConfig.ocr = false;
        // Remove undefined keys to prevent overwriting defaults in resolveParserConfig
        Object.keys(parserConfig).forEach((key) => parserConfig[key] === undefined && delete parserConfig[key]);
        /**
         * AUTOMATIC CONFIGURATION SYNC
         * We sync extractAttachments from the generator configuration.
         */
        parserConfig.extractAttachments = (config?.generatorConfig?.includeImages !== false) || (config?.generatorConfig?.includeCharts !== false);
        // 2. Parse the source document into the universal AST
        const ast = await OfficeParser_js_1.OfficeParser.parseOffice(file, parserConfig);
        // 3. Generate the destination document from the AST
        const generatorConfig = {
            ...config?.generatorConfig,
            onWarning: config?.onWarning || config?.generatorConfig?.onWarning,
        };
        // The spread widens the object to an inferred literal; it is a `GeneratorConfig<D>` by
        // construction (config.generatorConfig is already typed for D, and onWarning is common to
        // every destination), so the cast restates what the types otherwise lose.
        const result = await OfficeGenerator_js_1.OfficeGenerator.generate(ast, destination, generatorConfig);
        result.messages = [...(ast.warnings || []), ...result.messages];
        return result;
    }
}
exports.OfficeConverter = OfficeConverter;
