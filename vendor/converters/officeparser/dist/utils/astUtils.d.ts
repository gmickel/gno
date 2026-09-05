import { OfficeAttachment, OfficeAuxiliaryContent, OfficeContentNode, OfficeMetadata, OfficeParserAST, OfficeParserConfig, SupportedFileType } from '../types.js';
/**
 * Creates a fully-featured OfficeParserAST object with conversion methods.
 *
 * This helper ensures that all ASTs returned by officeParser have the latest
 * conversion methods (.to()) and maintain backward compatibility (.toText()).
 *
 * @param type - The detected file type
 * @param metadata - Document metadata
 * @param content - Parsed content nodes
 * @param attachments - Extracted attachments
 * @param config - Original parser configuration
 * @param toTextSync - Synchronous text extraction logic (for backward compatibility)
 * @returns An object conforming to OfficeParserAST
 */
export declare function createAST(type: SupportedFileType, metadata: OfficeMetadata, content: OfficeContentNode[], attachments: OfficeAttachment[], config: OfficeParserConfig, auxiliary: OfficeAuxiliaryContent | undefined, toTextSync: () => string): OfficeParserAST;
