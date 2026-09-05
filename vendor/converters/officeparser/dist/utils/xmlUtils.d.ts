/**
 * XML Parsing Utilities
 *
 * Provides helper functions for parsing and navigating XML documents.
 * Used extensively by OOXML parsers (DOCX, XLSX, PPTX) and OpenOffice parsers (ODT, ODP, ODS).
 *
 * OOXML (Office Open XML) is an XML-based format used by Microsoft Office.
 * Documents are ZIP archives containing multiple XML files describing structure, content, and formatting.
 *
 * @module xmlUtils
 */
import { OfficeMetadata } from '../types';
/**
 * Type guard for Element nodes.
 */
export declare const isElement: (node: Node) => node is Element;
/**
 * Parses an XML string into a DOM Document object.
 *
 * Uses the @xmldom/xmldom library to parse XML strings in a Node.js environment.
 *
 * @param xml - The XML content as a string
 * @param options - Optional parser settings (e.g., enable locators for source mapping)
 * @returns A Document object that can be queried using standard DOM methods
 */
export declare const parseXmlString: (xml: string, options?: {
    locator?: boolean;
}) => Document;
/**
 * Gets all elements with a specific tag name and returns them as an array.
 *
 * This is a convenience wrapper around the DOM API's getElementsByTagName method
 * that converts the HTMLCollection/NodeList to a proper JavaScript array for easier manipulation.
 *
 * @param element - The element or document to search within
 * @param tagName - The tag name to search for (e.g., 'w:t', 'w:p', 'item')
 * @returns An array of matching elements (empty array if none found)
 * @example
 * ```typescript
 * const paragraphs = getElementsByTagName(doc, 'w:p');
 * paragraphs.forEach(p => console.log(p.textContent));
 * ```
 */
export declare const getElementsByTagName: (element: Element | Document, tagName: string) => Element[];
export declare const serializeXml: (node: Node, options?: {
    preserveWhitespace?: boolean;
}) => string;
/**
 * Attempts to extract the original raw substring from the source XML for a given node.
 * Requires the document to have been parsed with { locator: true }.
 *
 * @param node - The DOM node to extract source for
 * @param sourceXml - The original XML source string
 * @returns The raw XML substring, or undefined if it cannot be reliably determined
 */
export declare const getSourceSubstring: (node: any, sourceXml: string) => string | undefined;
/**
 * High-level helper to get raw content for a node based on OfficeParserConfig.
 *
 * @param node - The DOM node
 * @param sourceXml - The original source XML string
 * @param config - The parser configuration
 * @returns The raw content string (serialized or original)
 */
export declare const getRawContent: (node: Node, sourceXml: string, config: {
    serializeRawContent?: boolean;
    preserveXmlWhitespace?: boolean;
}) => string;
/**
 * Gets the first element with the specified tag name within a parent element.
 *
 * @param parent - The parent element or document to search within
 * @param tagName - The tag name to search for
 * @returns The first matching element, or undefined if none found
 */
export declare const getFirstElementByTagName: (parent: Element | Document, tagName: string) => Element | undefined;
/**
 * Gets the value of an attribute from an element.
 *
 * @param element - The element to get the attribute from
 * @param attrName - The name of the attribute
 * @returns The attribute value or undefined if not set
 */
export declare const getAttribute: (element: Element, attrName: string) => string | undefined;
/**
 * Gets direct child elements with a specific tag name.
 * Unlike getElementsByTagName, this does not search recursively.
 *
 * @param parent - The parent element
 * @param tagName - The tag name to search for
 * @returns An array of matching direct child elements
 */
export declare const getDirectChildren: (parent: Element, tagName: string) => Element[];
/**
 * Parses OOXML document metadata from the docProps/core.xml file.
 *
 * OOXML documents (DOCX, XLSX, PPTX) store metadata in a standard location:
 * `docProps/core.xml` within the ZIP archive.
 *
 * This file follows the Dublin Core metadata standard with OOXML-specific extensions.
 * Common metadata elements:
 * - dc:title - Document title
 * - dc:creator - Original author
 * - cp:lastModifiedBy - User who last modified the document
 * - dcterms:created - Creation timestamp
 * - dcterms:modified - Last modification timestamp
 *
 * @param xmlContent - The raw XML content string from docProps/core.xml
 * @returns An OfficeMetadata object with extracted properties (empty object if parsing fails)
 * @example
 * ```typescript
 * const coreXml = files.find(f => f.path === 'docProps/core.xml').content.toString();
 * const metadata = parseOfficeMetadata(coreXml);
 *
 * console.log(metadata.author); // "John Smith"
 * console.log(metadata.title); // "Annual Report"
 * console.log(metadata.created); // Date object
 * ```
 *
 * @see https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/6c085e39-c695-4f83-91e8-3f277bb4e111
 */
export declare const parseOfficeMetadata: (xmlContent: string) => OfficeMetadata;
/**
 * Parses OOXML custom document properties from `docProps/custom.xml`.
 *
 * Custom properties are user-defined key/value pairs that authors can attach to OOXML documents
 * (DOCX, XLSX, PPTX). They are stored in `docProps/custom.xml` inside the ZIP archive.
 *
 * Property values are typed using the `vt:` namespace (docPropsVTypes):
 * - `vt:lpwstr` / `vt:lpstr` / `vt:bstr` → string
 * - `vt:bool` → boolean
 * - `vt:i1`..`vt:i8`, `vt:int`, `vt:r4`, `vt:r8`, `vt:decimal` → number
 * - `vt:filetime` / `vt:date` → Date
 *
 * @param xmlContent - Raw XML string from `docProps/custom.xml`
 * @returns A record of property name → typed value (empty object if none found)
 * @example
 * ```typescript
 * const customXml = files.find(f => f.path === 'docProps/custom.xml').content.toString();
 * const props = parseOOXMLCustomProperties(customXml);
 * console.log(props['Department']); // "Engineering"
 * console.log(props['Priority']);   // 1  (number)
 * console.log(props['Reviewed']);   // true (boolean)
 * ```
 */
export declare const parseOOXMLCustomProperties: (xmlContent: string) => Record<string, string | number | boolean | Date>;
/**
 * Parses OOXML application properties from `docProps/app.xml`.
 *
 * Application properties contain document statistics and application settings.
 *
 * @param xmlContent - Raw XML string from `docProps/app.xml`
 * @returns A record of property name -> typed value
 */
export declare const parseOOXMLAppProperties: (xmlContent: string) => Record<string, string | number | boolean>;
/**
 * Decodes XML entities (standard named entities, decimal, and hexadecimal entities) in a string.
 * Useful when parsing content with regular expressions instead of a full DOM parser.
 *
 * @param text - The XML-encoded string
 * @returns The decoded string
 */
export declare const decodeXmlEntities: (text: string) => string;
