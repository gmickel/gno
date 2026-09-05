"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OfficeGenerator = void 0;
const ChunkingGenerator_js_1 = require("./generators/ChunkingGenerator.js");
const CsvGenerator_js_1 = require("./generators/CsvGenerator.js");
const EpubGenerator_js_1 = require("./generators/EpubGenerator.js");
const HtmlGenerator_js_1 = require("./generators/HtmlGenerator.js");
const MarkdownGenerator_js_1 = require("./generators/MarkdownGenerator.js");
const PdfGenerator_js_1 = require("./generators/PdfGenerator.js");
const RtfGenerator_js_1 = require("./generators/RtfGenerator.js");
const TextGenerator_js_1 = require("./generators/TextGenerator.js");
const types_js_1 = require("./types.js");
const errorUtils_js_1 = require("./utils/errorUtils.js");
/**
 * Main generator class providing document conversion functionality.
 */
class OfficeGenerator {
    /**
     * Normalizes format aliases (e.g., 'txt' to 'text', 'markdown' to 'md') to standard internal formats.
     */
    static normalizeDestination(dest) {
        const d = dest?.toLowerCase();
        if (d === 'txt')
            return 'text';
        if (d === 'markdown')
            return 'md';
        return d;
    }
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
    static async generate(ast, destination, config) {
        let generator;
        const normalizedDestination = OfficeGenerator.normalizeDestination(destination);
        switch (normalizedDestination) {
            case 'text':
                generator = new TextGenerator_js_1.TextGenerator(ast, config);
                break;
            case 'md':
                generator = new MarkdownGenerator_js_1.MarkdownGenerator(ast, config);
                break;
            case 'html':
                generator = new HtmlGenerator_js_1.HtmlGenerator(ast, config);
                break;
            case 'pdf':
                generator = new PdfGenerator_js_1.PdfGenerator(ast, config);
                break;
            case 'csv':
                generator = new CsvGenerator_js_1.CsvGenerator(ast, config);
                break;
            case 'rtf':
                generator = new RtfGenerator_js_1.RtfGenerator(ast, config);
                break;
            case 'chunks':
                generator = new ChunkingGenerator_js_1.ChunkingGenerator(ast, config);
                break;
            case 'epub':
                generator = new EpubGenerator_js_1.EpubGenerator(ast, config);
                break;
            default:
                throw (0, errorUtils_js_1.getOfficeError)(types_js_1.OfficeErrorType.FORMAT_UNSUPPORTED, undefined, destination);
        }
        return generator.generate();
    }
}
exports.OfficeGenerator = OfficeGenerator;
