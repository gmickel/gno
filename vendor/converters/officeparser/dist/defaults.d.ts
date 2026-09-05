import { DeepRequired, DocumentStructureChunkingConfig, FixedSizeChunkingConfig, FullGeneratorConfig, OfficeParserConfig, SemanticChunkingConfig } from './types.js';
/**
 * The default regex used for identifying sentence boundaries.
 * When this default is used, the generator employs a high-fidelity "robust"
 * segmenter that accounts for common abbreviations (Mr., Dr., etc.).
 */
export declare const DEFAULT_SENTENCE_BOUNDARY_REGEX: RegExp;
/**
 * Common abbreviations that should not trigger a sentence split when followed by a period.
 */
export declare const DEFAULT_ABBREVIATIONS: string[];
/**
 * Default configuration for the OfficeParser.
 */
export declare const DEFAULT_OFFICE_PARSER_CONFIG: DeepRequired<OfficeParserConfig>;
/**
 * Default configuration for Fixed-Size chunking.
 */
export declare const DEFAULT_FIXED_SIZE_CHUNKING_CONFIG: Required<Omit<FixedSizeChunkingConfig, 'embeddingFunction' | 'sentenceBoundaryRegex' | 'abbreviations'>> & {
    sentenceBoundaryRegex: string | RegExp;
    abbreviations: string[];
};
/**
 * Default configuration for Document-Structure chunking.
 */
export declare const DEFAULT_DOCUMENT_STRUCTURE_CHUNKING_CONFIG: Required<Omit<DocumentStructureChunkingConfig, 'sentenceBoundaryRegex' | 'abbreviations'>> & {
    sentenceBoundaryRegex: string | RegExp;
    abbreviations: string[];
};
/**
 * Default configuration for Semantic chunking.
 * Note: `embeddingFunction` has no meaningful default and must be provided by the user.
 */
export declare const DEFAULT_SEMANTIC_CHUNKING_CONFIG: Required<Omit<SemanticChunkingConfig, 'embeddingFunction' | 'sentenceBoundaryRegex' | 'abbreviations'>> & {
    sentenceBoundaryRegex: string | RegExp;
    abbreviations: string[];
};
/**
 * Default configuration for the OfficeGenerator.
 */
export declare const DEFAULT_GENERATOR_CONFIG: FullGeneratorConfig;
