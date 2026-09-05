"use strict";
/**
 * officeparser - Universal Office Document Parser
 *
 * A comprehensive Node.js library for parsing Microsoft Office and OpenDocument files
 * into structured Abstract Syntax Trees (AST) with full formatting information.
 *
 * **Supported Formats:**
 * - Microsoft Office: DOCX, XLSX, PPTX (Office Open XML)
 * - OpenDocument: ODT, ODP, ODS (ODF)
 * - Portable: PDF
 * - Legacy: RTF (Rich Text Format)
 * - Web/Plain: CSV, MD, HTML
 * - E-book: EPUB
 *
 * **Key Features:**
 * - Unified AST output across all formats
 * - Rich text formatting (bold, italic, colors, fonts, etc.)
 * - Document structure (headings, lists, tables)
 * - Image extraction with optional OCR
 * - Metadata extraction
 * - TypeScript support with full type definitions
 *
 * **Quick Start:**
 * ```typescript
 * import { OfficeParser } from 'officeparser';
 *
 * const ast = await OfficeParser.parseOffice('document.docx', {
 *   extractAttachments: true,
 *   ocr: true,
 *   includeRawContent: false
 * });
 *
 * console.log(ast.toText()); // Plain text output
 * console.log(ast.content);  // Structured content tree
 * console.log(ast.metadata); // Document metadata
 * ```
 *
 * **Main Exports:**
 * - `OfficeParser` - Main parser class
 * - `OfficeGenerator` - Main generator class for document conversion
 * - `OfficeParserConfig` - Configuration interface
 * - `GeneratorConfig` - Generator configuration interface
 * - `OfficeParserAST` - AST result interface
 * - `OfficeContentNode` - Content tree node interface
 * - All type definitions

 *
 * @packageDocumentation
 * @module officeparser
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OfficeWarningType = exports.OfficeErrorType = exports.generate = exports.convert = exports.OfficeConverter = exports.OfficeGenerator = exports.terminateOcr = exports.parseOffice = exports.OfficeParser = void 0;
const OfficeParser_js_1 = require("./OfficeParser.js");
Object.defineProperty(exports, "OfficeParser", { enumerable: true, get: function () { return OfficeParser_js_1.OfficeParser; } });
const OfficeGenerator_js_1 = require("./OfficeGenerator.js");
Object.defineProperty(exports, "OfficeGenerator", { enumerable: true, get: function () { return OfficeGenerator_js_1.OfficeGenerator; } });
const OfficeConverter_js_1 = require("./OfficeConverter.js");
Object.defineProperty(exports, "OfficeConverter", { enumerable: true, get: function () { return OfficeConverter_js_1.OfficeConverter; } });
const types_js_1 = require("./types.js");
Object.defineProperty(exports, "OfficeErrorType", { enumerable: true, get: function () { return types_js_1.OfficeErrorType; } });
Object.defineProperty(exports, "OfficeWarningType", { enumerable: true, get: function () { return types_js_1.OfficeWarningType; } });
const parseOffice = OfficeParser_js_1.OfficeParser.parseOffice;
exports.parseOffice = parseOffice;
const terminateOcr = OfficeParser_js_1.OfficeParser.terminateOcr;
exports.terminateOcr = terminateOcr;
const convert = OfficeConverter_js_1.OfficeConverter.convert;
exports.convert = convert;
const generate = OfficeGenerator_js_1.OfficeGenerator.generate;
exports.generate = generate;
// Default export for backward compatibility
exports.default = OfficeParser_js_1.OfficeParser;
