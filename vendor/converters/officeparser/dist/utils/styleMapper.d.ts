import { OfficeContentNode, StructuredStyleMapping } from '../types.js';
export interface StyleMapping {
    selector: {
        nodeType?: string;
        attributes: Record<string, {
            value: string | number | boolean;
            operator: '=' | '~=';
            compiled?: RegExp;
        }>;
    };
    output: {
        tag: string;
        classes: string[];
        attributes: Record<string, string>;
        fresh: boolean;
    };
}
/**
 * Parser and matcher for the style mapping DSL.
 * Supports a structured JSON format and a legacy string DSL.
 */
export declare class StyleMapper {
    private mappings;
    constructor(mappings?: string[] | StructuredStyleMapping[] | Record<string, any>, ignoreDefaults?: boolean);
    /**
     * Finds the best matching mapping for a node.
     */
    getMapping(node: OfficeContentNode): StyleMapping['output'] | undefined;
    private matches;
    private getNodeAttribute;
    private convertStructuredMapping;
    /**
     * Parses a mapping string like "p[style-name='Heading 1'] => h1.title:fresh"
     */
    private parseMappingString;
}
