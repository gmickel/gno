import { ConversionResult, GeneratorConfig, OfficeParserAST } from '../types.js';
import { BaseGenerator } from './BaseGenerator.js';
/**
 * Generates a list of OfficeChunk objects from an AST for use in RAG pipelines.
 * Supports three strategies: 'fixed-size', 'document-structure', and 'semantic'.
 */
export declare class ChunkingGenerator extends BaseGenerator<'chunks'> {
    /** The resolved chunking config (with defaults applied). */
    private chunkConfig;
    /** Whether the user provided an explicit sentence boundary regex. */
    private isCustomRegex;
    constructor(ast: OfficeParserAST, config?: GeneratorConfig<'chunks'>);
    /**
     * Merges the user's chunking config with the appropriate defaults for the chosen strategy.
     */
    private resolveChunkingConfig;
    /**
     * Main entry point. Routes to the correct strategy implementation.
     * Note: ConversionResult.value is a real OfficeChunk[] array for the 'chunks' destination, not
     * a JSON string. Consumers serialize it to JSON/JSONL themselves.
     */
    generate(): Promise<ConversionResult<'chunks'>>;
    /**
     * Splits the full document text into fixed-size chunks with optional overlap.
     * Attempts to split on natural separators before hard-cutting.
     */
    private generateFixedSize;
    /**
     * Recursively tries separators to split text into chunks of at most `chunkSize`,
     * with `chunkOverlap` characters of overlap between consecutive chunks.
     */
    private splitTextRecursively;
    /**
     * Walks the AST and splits at the designated structural boundaries (slide, page, heading, paragraph).
     */
    private generateDocumentStructure;
    private processNodeForStructure;
    private isStructuralBoundary;
    /**
     * Handles table chunking with the configured tableSplitStrategy.
     * 'row': keeps header row attached to every chunk.
     * 'flatten': converts table to text and splits normally.
     */
    private processTableNode;
    /**
     * Renders a list of row nodes as a pipe-separated text string.
     */
    private renderRowsAsText;
    /**
     * Splits document into semantically coherent chunks using cosine similarity
     * between sentence embeddings. A new chunk begins when similarity drops
     * below `similarityThreshold`.
     */
    private generateSemantic;
    /**
     * Extracts all text sentences from the AST with their contextual metadata.
     */
    private extractSentences;
    /**
     * Builds a flat text string from the entire document and a map of
     * character offsets to AST node metadata for position-based metadata lookups.
     */
    private buildFlatTextWithPositions;
    /**
     * Finds the closest AST metadata for a given character position.
     */
    private enrichMetadataFromPosition;
    /**
     * Applies final post-processing: strips whitespace, sets sourceType.
     */
    private finalizeChunks;
    /**
     * Helper to process embeddings in sequential batches to avoid API rate limits and memory issues.
     */
    private batchEmbeddings;
    private cosineSimilarity;
    private averageEmbeddings;
    /**
     * Robustly splits text into sentences, respecting abbreviations and non-Western punctuation.
     */
    private splitIntoSentences;
}
