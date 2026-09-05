/**
 * Converts an OMML subtree (`<m:oMath>` or any node within one) to LaTeX.
 *
 * Covers the constructs that actually appear in office documents: fractions, sub/superscripts,
 * delimiters, radicals, n-ary operators, functions, accents, bars, boxes and matrices. Anything
 * unrecognized falls through to concatenating its children, which is the old behaviour and the
 * right degradation for a construct that carries no grouping of its own.
 */
export declare const ommlToLatex: (node: Node, depth?: number) => string;
/**
 * The subset of a parsed element every MathML source here can present.
 *
 * MathML reaches this module from two different tree types - the XML DOM (ODF embedded objects)
 * and `HtmlParser`'s own lightweight node (HTML, and EPUB via its spine items) - so the converter
 * is written against this shape and each caller adapts into it. That keeps one implementation of
 * the conversion rather than one per tree type, which is how HTML came to have no MathML support
 * at all while ODF did.
 */
export interface MathNode {
    /** Tag name, namespace prefix included or not; `undefined` marks a text node. */
    tagName?: string;
    attributes?: Record<string, string>;
    /** Literal text, for text nodes and for leaf tokens. */
    text?: string;
    children: MathNode[];
}
/**
 * Converts a MathML subtree to LaTeX.
 *
 * When the document carries a TeX annotation (`<annotation encoding="application/x-tex">`), that
 * is the author's own source and is used verbatim in preference to anything reconstructed here.
 * ODF's `<annotation encoding="StarMath 5.0">` is deliberately not used - StarMath is not LaTeX,
 * and emitting it would put a second notation back into the output this module exists to unify.
 */
export declare const mathmlTreeToLatex: (node: MathNode, depth?: number) => string;
/** Converts a MathML subtree held in an XML DOM (ODF embedded objects) to LaTeX. */
export declare const mathmlToLatex: (node: Node, depth?: number) => string;
/**
 * True when a converted equation carries nothing worth emitting, so callers can drop the node
 * instead of pushing an empty `$$` into the output.
 */
export declare const isEmptyMath: (latex: string) => boolean;
