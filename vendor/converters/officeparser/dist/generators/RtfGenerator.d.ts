import { ConversionResult, GeneratorConfig, OfficeContentNode, OfficeParserAST } from '../types.js';
import { BaseGenerator } from './BaseGenerator.js';
/**
 * Generates high-fidelity RTF (Rich Text Format) from an AST.
 */
export declare class RtfGenerator extends BaseGenerator<'rtf'> {
    private colorTable;
    private inTable;
    /**
     * Set while rendering a heading's children.
     *
     * A heading emits its own `{\\b\\fs44 ...}` wrapper, so a run inside it that also carries bold
     * and a size - which is now the normal case for ODF, where the heading's paragraph style is
     * inherited by its runs - would emit a nested `\\fs28` that *overrides* the outer `\\fs44`.
     * The heading then renders at the body-text size it was styled with rather than at heading
     * size. Suppressing the inherited weight and size inside a heading keeps the heading's own
     * wrapper authoritative; every other property (colour, font) still comes through.
     */
    private inHeading;
    /** As `inHeading`, but for the inherited font size - see `hasUniformFormatting`. */
    private headingUniformSize;
    constructor(ast: OfficeParserAST, config?: GeneratorConfig<'rtf'>);
    generate(): Promise<ConversionResult<'rtf'>>;
    protected processNodeRecursive(node: OfficeContentNode, processor: (node: OfficeContentNode, childrenOutput: string) => Promise<string>): Promise<string>;
    private renderBody;
    private getColorIndex;
    private isLightColor;
    private escapeRtf;
}
