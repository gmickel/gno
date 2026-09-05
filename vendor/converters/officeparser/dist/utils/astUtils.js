"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAST = createAST;
const OfficeGenerator_js_1 = require("../OfficeGenerator.js");
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
function createAST(type, metadata, content, attachments, config, auxiliary, toTextSync) {
    return {
        config,
        type,
        metadata,
        content,
        attachments,
        auxiliary,
        warnings: [],
        toText: toTextSync,
        async to(destination, genConfig) {
            return OfficeGenerator_js_1.OfficeGenerator.generate(this, destination, genConfig);
        }
    };
}
