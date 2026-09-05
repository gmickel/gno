import { ConversionResult, GeneratorConfig, OfficeContentNode, OfficeParserAST } from '../types.js';
import { BaseGenerator } from './BaseGenerator.js';
/**
 * Generates Markdown from an AST.
 *
 * DESIGN PRINCIPLES:
 * 1. **Strict Native Preference**: Always utilize native Markdown syntax for features that
 *    are natively supported (headings, lists, bold/italic, etc.). HTML tags should NEVER
 *    be used for these features.
 *
 * 2. **Fidelity vs. Purity (The `fallbackToHtml` Principle)**:
 *    - When a given `fallbackToHtml` part is TRUE: The generator prioritizes high-fidelity
 *      document conversion for that part. It will use HTML tags for features that Markdown
 *      cannot natively represent (e.g., `<u>` for underline, `<div>` for alignment, `<table>`
 *      for nested structures or merged cells).
 *    - When FALSE: The generator prioritizes "pure" Markdown for that part.
 *      Unsupported features are either:
 *      - **Skipped**: Non-essential formatting like underline, subscript, superscript,
 *        or text alignment is omitted.
 *      - **Simplified/Hoisted**: Complex structures like nested tables are hoisted out
 *        of their parent cells and rendered as separate sequential tables to maintain
 *        valid Markdown syntax.
 *
 * 3. **Consistency**: All similar structural or formatting ideological problems must be
 *    resolved using these same rules to ensure predictable output.
 *
 * 4. **Dialect (`MdGeneratorConfig.dialect`)**: A second, independent axis from `fallbackToHtml` -
 *    which *native* Markdown syntax to emit for constructs with more than one real-world
 *    convention (admonitions, definition lists, footnotes, citations, wikilinks, math, list/
 *    emphasis markers, tables). See `resolveDialect()` and `MARKDOWN_DIALECT_PRESETS` above.
 */
export declare class MarkdownGenerator extends BaseGenerator<'md'> {
    private isInsideTable;
    /**
     * Set while rendering the children of a heading, or the cells of a table's header row.
     *
     * Markdown already conveys "this is a heading" with `#` and "this is a header row" with the
     * separator line, so a run inside one that also carries bold - the normal case for ODF, whose
     * heading and header-row paragraph styles are bold and are now inherited by their runs - would
     * render as `# **Heading**` and `| **ITEM** |`. That is redundant rather than wrong, but it
     * also round-trips back into bold text nodes nested inside a heading, so the noise compounds
     * on every parse/generate cycle. Emphasis the node type already implies is dropped; every
     * other formatting flag still comes through.
     */
    private inImplicitBold;
    private hoistedContent;
    private collectedAbbreviations;
    private resolvedDialect;
    private resolvedFallbackToHtml;
    private resolvedEmbeds;
    constructor(ast: OfficeParserAST, config?: GeneratorConfig<'md'>);
    /**
     * Renders anchor tags if HTML fallback is allowed.
     */
    private renderAnchors;
    /**
     * Serializes a frontmatter array as a YAML flow sequence (e.g. `[a, b]`), matching
     * MarkdownParser's frontmatter array handling. Plain strings are left bare; anything
     * that would break flow-array syntax (or isn't a string) falls back to JSON encoding.
     */
    private serializeFrontmatterArray;
    /**
     * Renders a Pandoc-style attribute list (e.g. `{width=50% align=left}`) from
     * ImageMetadata/TableMetadata's width/align fields - the canonical form is always
     * `key=value`, matching MarkdownParser's own vocabulary (MARKDOWN_DIALECT.md §15).
     */
    private renderAttributeList;
    /** Converts a document-supplied date to an ISO string, or '' if invalid
     *  (a malformed date would otherwise throw a RangeError and abort generation). */
    private toIsoDate;
    /**
     * Generates Markdown string from the provided AST.
     *
     * @returns A Markdown string
     */
    generate(): Promise<ConversionResult<'md'>>;
    /**
     * Recursively processes nodes and builds output.
     * Overridden to provide AST optimization (merging adjacent text nodes).
     */
    protected processNodeRecursive(node: OfficeContentNode, processor: (node: OfficeContentNode, childrenOutput: string) => string | Promise<string>): Promise<string>;
    /**
     * Merges adjacent text nodes with identical formatting and metadata.
     */
    private optimizeNodes;
    private areFormattingEqual;
    private renderMarkdownTable;
    private collectNotesFrom;
    private renderMarkdownTableInternal;
    private hasNestedTable;
    private hasColspanOrRowspan;
    /**
     * Renders a complex table as HTML since Markdown doesn't support nested tables or rowspans.
     */
    private renderTableAsHtml;
}
