import { OfficeIssue, ConversionResult, FullGeneratorConfig, GeneratorConfig, OfficeContentNode, OfficeMetadata, OfficeParserAST, OfficeWarningType, UniversalGeneratorFormat } from '../types.js';
import { StyleMapper } from '../utils/styleMapper.js';
/**
 * Base class for all document generators.
 * Provides common traversal logic and configuration handling.
 */
export declare abstract class BaseGenerator<D extends UniversalGeneratorFormat = UniversalGeneratorFormat> {
    protected destination: D;
    protected config: FullGeneratorConfig;
    protected ast: OfficeParserAST;
    protected messages: OfficeIssue[];
    protected styleMapper: StyleMapper;
    protected collectedNotes: OfficeContentNode[];
    constructor(destination: D, ast: OfficeParserAST, config?: GeneratorConfig<D> | FullGeneratorConfig);
    /**
     * The document metadata a generator should write out: `ast.metadata` with
     * `config.metadataOverrides` applied on top, per field.
     *
     * Every generator must read metadata through here rather than touching `this.ast.metadata`
     * directly, so an override reaches all of them uniformly instead of one format at a time.
     *
     * Merged rather than replaced, so overriding one field doesn't blank the rest, and computed
     * fresh rather than cached on the AST: overrides are an output concern, and mutating
     * `ast.metadata` would leak one generation's settings into the next use of the same AST.
     * `custom` merges into `customProperties` so callers see one bucket regardless of origin.
     */
    protected get effectiveMetadata(): OfficeMetadata;
    /**
     * Reports caller-supplied `metadataOverrides.custom` entries that the destination format has
     * no way to represent (EPUB's OPF and RTF's `\info` both have fixed vocabularies).
     *
     * Warning rather than dropping silently: a caller who sets metadata and never sees it in the
     * output otherwise has no way to find out. Only `custom` keys are reported - the named fields
     * map onto something in every format that carries metadata at all.
     */
    protected warnUnrepresentableCustomMetadata(format: string): void;
    /**
     * Retrieves the semantic mapping for a node, respecting the includeFormatting flag.
     * Per design requirements: Style mapping is bypassed if formatting is disabled.
     */
    protected getSemanticMapping(node: OfficeContentNode): {
        tag: string;
        classes: string[];
        attributes: Record<string, string>;
        fresh: boolean;
    } | undefined;
    /**
     * Entry point for generation.
     */
    abstract generate(): Promise<ConversionResult<D>>;
    /**
     * Centralized logic for handling the onNode callback.
     * Evaluates the callback and returns a result that tells the generator how to proceed.
     *
     * @returns
     * - `string`: Use this as the node's output, skip default processing.
     * - `false`: Skip this node and its subtree.
     * - `void`: Proceed with default processing.
     */
    protected handleOnNode(node: OfficeContentNode): Promise<string | false | void>;
    /**
     * Recursively processes nodes and builds output.
     *
     * @param node - The current node being processed
     * @param processor - A function that takes a node and its children's output and returns the node's output string.
     * @returns The generated string for this node and its subtree.
     */
    protected processNodeRecursive(node: OfficeContentNode, processor: (node: OfficeContentNode, childrenOutput: string) => string | Promise<string>): Promise<string>;
    /**
     * Helper to generate a unique ID (slug) from text.
     */
    protected slugify(text: string): string;
    private noteFootnoteKeys;
    private usedFootnoteKeys;
    private footnoteKeyCounter;
    /**
     * Assigns a stable, unique reference key to a footnote/endnote node, reused for both
     * its inline reference marker and its collected definition. Source ids aren't reliably
     * unique across a document - DOCX/ODT number footnotes and endnotes in separate
     * sequences, so both can carry noteId "1" - so a source id is only reused when it
     * hasn't already been claimed; otherwise a sequential counter guarantees uniqueness.
     */
    protected getFootnoteKey(note: OfficeContentNode): string;
    /**
     * True when every content-bearing text descendant satisfies `test` - i.e. the property is
     * uniform across the whole node and therefore says nothing the node type does not already say.
     *
     * Used to decide whether a heading's or header row's inherited formatting can be dropped. The
     * distinction matters: an ODF heading whose paragraph style is bold and 14pt yields a heading
     * where *every* run is bold and 14pt, and re-emitting that gives `# **Heading**` in Markdown
     * and, worse in RTF/HTML, an inner font-size that overrides the heading's own and visibly
     * shrinks it. But `# Normal **Bold** Normal` is an author contrasting one word against the
     * rest, and dropping that would discard real meaning. Only the uniform case is safe.
     *
     * Returns false when there is no text to judge, so an empty or image-only node never triggers
     * suppression.
     */
    protected hasUniformFormatting(node: OfficeContentNode, test: (formatting: OfficeContentNode['formatting']) => boolean): boolean;
    /**
     * Recursively extracts plain text from a node and its children.
     */
    protected getNodeText(node: OfficeContentNode): string;
    /**
     * Reports a warning to the user and collects it for the final result.
     */
    protected warn(type: OfficeWarningType, info?: any, node?: OfficeContentNode): void;
}
