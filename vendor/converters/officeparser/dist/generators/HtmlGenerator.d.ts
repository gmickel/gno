import { ConversionResult, GeneratorConfig, OfficeContentNode, OfficeParserAST } from '../types.js';
import { BaseGenerator } from './BaseGenerator.js';
/**
 * Generates semantic, high-fidelity HTML from an AST.
 */
export declare class HtmlGenerator extends BaseGenerator<'html'> {
    private chartCounter;
    private isSpreadsheetMode;
    /**
     * Set while rendering a heading's children, so `formatText` can drop the run-level bold and
     * font-size the `<hN>` already establishes. See the note there, and the identical flag in
     * `RtfGenerator`, where the same inherited size actively shrinks the heading.
     */
    private inHeading;
    /** As `inHeading`, but for the inherited font size - see `hasUniformFormatting`. */
    private headingUniformSize;
    constructor(ast: OfficeParserAST, config?: GeneratorConfig<'html'>);
    /**
     * Generates HTML string from the provided AST.
     *
     * @returns An HTML string
     */
    generate(): Promise<ConversionResult<'html'>>;
    private renderMetaTags;
    private renderMetadataSummary;
    /**
     * Processes an array of nodes, handling list grouping and nesting.
     */
    private processNodeArray;
    /**
     * Overridden to handle children using processNodeArray for list grouping.
     */
    private tableNestingLevel;
    protected processNodeRecursive(node: OfficeContentNode, processor: (node: OfficeContentNode, childrenOutput: string) => string | Promise<string>, override?: string | boolean | void): Promise<string>;
    private processNodeRecursiveInner;
    /**
     * Internal processor for individual nodes.
     */
    private nodeProcessor;
    private getDefaultTag;
    private formatText;
    private getInlineStyles;
    private getPremiumStyles;
    /**
     * Same as `getPremiumStyles()`, but wrapped in a CSS `@scope` block anchored to the
     * `.op-html-scope` wrapper so the rules only apply within the generated fragment - they
     * cannot leak onto a host page's own elements. `:root` and `body` selectors specifically
     * target the real page root/body, so they're remapped to `:scope` (the scope root, i.e. the
     * `.op-html-scope` wrapper) first; every other selector is naturally confined by `@scope`
     * without needing per-selector rewriting. `customCss` is included in this scoping too.
     */
    private getScopedPremiumStyles;
    protected slugify(text: string): string;
    private getColumnLetter;
    private escape;
    /** Converts a document-supplied date to an ISO string, or '' if it is invalid
     *  (a malformed date would otherwise throw a RangeError and abort generation). */
    private toIsoDate;
}
