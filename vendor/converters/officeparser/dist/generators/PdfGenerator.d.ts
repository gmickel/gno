import { ConversionResult, GeneratorConfig, OfficeParserAST } from '../types.js';
import { BaseGenerator } from './BaseGenerator.js';
/**
 * Generates high-fidelity PDF documents using a headless browser engine.
 *
 * Uses an environment-aware strategy:
 * - Node.js: Uses Puppeteer (peer dependency) for server-side rendering.
 * - Browser: Leverages native browser print capabilities.
 */
export declare class PdfGenerator extends BaseGenerator<'pdf'> {
    constructor(ast: OfficeParserAST, config?: GeneratorConfig<'pdf'>);
    generate(): Promise<ConversionResult<'pdf'>>;
    /**
     * Node.js implementation using Puppeteer.
     * Uses dynamic import to avoid bundling puppeteer into the library core.
     */
    private generateInNode;
    /**
     * Browser implementation using hidden iframe and native print.
     */
    private generateInBrowser;
}
