"use strict";
/**
 * Word Document (DOCX) Parser
 *
 * **DOCX Format Overview:**
 * DOCX is the default format for Microsoft Word documents since Office 2007.
 * It's based on the Office Open XML (OOXML) standard (ECMA-376, ISO/IEC 29500).
 *
 * **File Structure:**
 * DOCX files are ZIP archives containing:
 * - `word/document.xml` - Main document content
 * - `word/styles.xml` - Style definitions
 * - `word/numbering.xml` - List numbering definitions
 * - `word/footnotes.xml` - Footnotes content
 * - `word/media/*` - Embedded images and media
 * - `docProps/core.xml` - Document metadata
 * - `[Content_Types].xml` - MIME type mappings
 *
 * **XML Structure (word/document.xml):**
 * ```xml
 * <w:document>
 *   <w:body>
 *     <w:p>                    <!-- Paragraph -->
 *       <w:pPr>                <!-- Paragraph properties -->
 *         <w:pStyle w:val="Heading1"/>
 *       </w:pPr>
 *       <w:r>                  <!-- Run (text with same formatting) -->
 *         <w:rPr>              <!-- Run properties -->
 *           <w:b/>             <!-- Bold -->
 *           <w:sz w:val="24"/> <!-- Font size (half-points) -->
 *         </w:rPr>
 *         <w:t>Hello</w:t>     <!-- Text -->
 *       </w:r>
 *     </w:p>
 *   </w:body>
 * </w:document>
 * ```
 *
 * **Key OOXML Elements:**
 * - `<w:p>` - Paragraph
 * - `<w:r>` - Run (contiguous text with same formatting)
 * - `<w:t>` - Text content
 * - `<w:br>` - Line or page break
 * - `<w:b>`, `<w:i>`, `<w:u>` - Bold, italic, underline
 * - `<w:pStyle>` - Paragraph style (for headings)
 * - `<w:numPr>` - List numbering properties
 * - `<w:tbl>` - Table
 * - `<w:drawing>` - Drawing/image
 *
 * **Parsing Approach:**
 * 1. Extract ZIP contents
 * 2. Parse word/document.xml for structure and text
 * 3. Extract formatting from run properties (rPr)
 * 4. Identify headings via paragraph styles
 * 5. Extract footnotes from word/footnotes.xml
 * 6. Process embedded images from word/media/*
 * 7. Parse metadata from docProps/core.xml
 *
 * @module WordParser
 * @see https://www.ecma-international.org/publications-and-standards/standards/ecma-376/ OOXML Standard
 * @see https://learn.microsoft.com/en-us/openspecs/office_standards/ms-docx/ [MS-DOCX] Specification
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseWord = void 0;
const types_js_1 = require("../types.js");
const astUtils_js_1 = require("../utils/astUtils.js");
const errorUtils_js_1 = require("../utils/errorUtils.js");
const imageUtils_js_1 = require("../utils/imageUtils.js");
const mathUtils_js_1 = require("../utils/mathUtils.js");
const ocrUtils_js_1 = require("../utils/ocrUtils.js");
const xmlUtils_js_1 = require("../utils/xmlUtils.js");
const zipUtils_js_1 = require("../utils/zipUtils.js");
/**
 * Parses a Word document (.docx) and extracts content, formatting, and metadata.
 *
 * The parsing process:
 * 1. Unzip the DOCX file
 * 2. Parse word/document.xml to extract paragraphs and runs
 * 3. Extract text formatting from run properties
 * 4. Identify headings from paragraph styles
 * 5. Process lists from numbering properties
 * 6. Extract images and optionally perform OCR
 * 7. Parse document metadata
 *
 * @param buffer - The DOCX file as a Buffer
 * @param config - Parser configuration options
 * @returns A promise resolving to the parsed AST
 */
const parseWord = async (buffer, config) => {
    // Honour cancellation requests immediately — before opening the ZIP archive, loading XML
    // files, or kicking off any OCR work.  DOCX files can be large and the inflate + XML-parse
    // steps are synchronous-heavy, so failing fast here avoids wasted CPU time.
    (0, errorUtils_js_1.checkAbortSignal)(config.abortSignal);
    const documentFileRegex = /word\/document[\d+]?.xml/;
    const footnotesFileRegex = /word\/footnotes[\d+]?.xml/;
    const endnotesFileRegex = /word\/endnotes[\d+]?.xml/;
    const commentsFileRegex = /word\/comments[\d+]?.xml/;
    // Headers and footers are the only parts a document can have many of: Word writes up to
    // three per section (default, first page, even pages), so a handful of sections is enough
    // to reach header10.xml. The single-character form the other parts use stops matching at
    // nine, which would drop those later files as silently as not extracting them at all.
    const headerFileRegex = /word\/header\d*\.xml/;
    const footerFileRegex = /word\/footer\d*\.xml/;
    const numberingFileRegex = /word\/numbering[\d+]?.xml/;
    const mediaFileRegex = /(word\/)?media\/.*/;
    const corePropsFileRegex = /docProps\/core[\d+]?.xml/;
    const customPropsFileRegex = /docProps\/custom\.xml/;
    const appPropsFileRegex = /docProps\/app[\d+]?.xml/;
    const relsFileRegex = /word\/_rels\/document[\d+]?.xml\.rels/;
    const stylesFileRegex = /word\/styles[\d+]?.xml/;
    // Helper to extract formatting from run properties XML string
    const extractFormattingFromXml = (rPr) => {
        const formatting = {};
        // Helper to check boolean properties (e.g., <w:b />, <w:i w:val="0" />)
        const getBoolVal = (parent, tagName) => {
            const el = (0, xmlUtils_js_1.getFirstElementByTagName)(parent, tagName);
            if (el) {
                const val = el.getAttribute('w:val');
                // In OOXML, if the element is present without w:val, it's true.
                // If w:val is present, it can be '1', 'true', 'on' for true.
                if (val === null)
                    return true;
                return val === '1' || val === 'true' || val === 'on';
            }
            return null;
        };
        const bold = getBoolVal(rPr, 'w:b');
        if (bold !== null)
            formatting.bold = bold;
        const italic = getBoolVal(rPr, 'w:i');
        if (italic !== null)
            formatting.italic = italic;
        const u = (0, xmlUtils_js_1.getFirstElementByTagName)(rPr, 'w:u');
        if (u) {
            const val = u.getAttribute('w:val');
            // If val is missing, it's a default underline (true). 
            // If val is present, it's true unless explicit 'none'.
            if (!val || val !== 'none') {
                formatting.underline = true;
            }
        }
        const strike = getBoolVal(rPr, 'w:strike');
        const dstrike = getBoolVal(rPr, 'w:dstrike');
        if (strike !== null)
            formatting.strikethrough = strike;
        else if (dstrike !== null)
            formatting.strikethrough = dstrike;
        // Font size (w:sz) - stored in half-points
        const sz = (0, xmlUtils_js_1.getFirstElementByTagName)(rPr, 'w:sz');
        if (sz) {
            const val = sz.getAttribute('w:val');
            if (val) {
                formatting.size = (parseInt(val, 10) / 2).toString() + 'pt';
            }
        }
        // Color (w:color)
        const color = (0, xmlUtils_js_1.getFirstElementByTagName)(rPr, 'w:color');
        if (color) {
            const val = color.getAttribute('w:val');
            if (val && val !== 'auto') {
                formatting.color = '#' + val;
            }
        }
        // Background color (w:shd) - shading
        const shd = (0, xmlUtils_js_1.getFirstElementByTagName)(rPr, 'w:shd');
        if (shd) {
            const val = shd.getAttribute('w:fill');
            if (val && val !== 'auto') {
                formatting.backgroundColor = '#' + val;
            }
        }
        // Highlight (w:highlight) - maps to background color in our AST
        const highlight = (0, xmlUtils_js_1.getFirstElementByTagName)(rPr, 'w:highlight');
        if (highlight) {
            const val = highlight.getAttribute('w:val');
            if (val && val !== 'none') {
                const colorMap = {
                    'yellow': '#FFFF00', 'green': '#00FF00', 'cyan': '#00FFFF', 'magenta': '#FF00FF',
                    'blue': '#0000FF', 'red': '#FF0000', 'darkBlue': '#00008B', 'darkCyan': '#008B8B',
                    'darkGreen': '#006400', 'darkMagenta': '#8B008B', 'darkRed': '#8B0000',
                    'darkYellow': '#808000', 'darkGray': '#A9A9A9', 'lightGray': '#D3D3D3', 'black': '#000000'
                };
                formatting.backgroundColor = colorMap[val] || val;
            }
        }
        // Font family (w:rFonts)
        const rFonts = (0, xmlUtils_js_1.getFirstElementByTagName)(rPr, 'w:rFonts');
        if (rFonts) {
            // Priority: ascii (Western) > hAnsi (High ANSI)
            const font = rFonts.getAttribute('w:ascii') || rFonts.getAttribute('w:hAnsi');
            if (font) {
                formatting.font = font;
            }
        }
        // Subscript/Superscript (w:vertAlign)
        const vertAlign = (0, xmlUtils_js_1.getFirstElementByTagName)(rPr, 'w:vertAlign');
        if (vertAlign) {
            const val = vertAlign.getAttribute('w:val');
            if (val === 'subscript')
                formatting.subscript = true;
            else if (val === 'superscript')
                formatting.superscript = true;
        }
        return formatting;
    };
    // Helper to extract indentation from paragraph properties XML string
    const extractIndentationFromXml = (pPr) => {
        const ind = (0, xmlUtils_js_1.getFirstElementByTagName)(pPr, "w:ind");
        if (ind) {
            const indentation = {};
            const left = ind.getAttribute("w:left") || ind.getAttribute("w:start");
            const right = ind.getAttribute("w:right") || ind.getAttribute("w:end");
            const firstLine = ind.getAttribute("w:firstLine");
            const hanging = ind.getAttribute("w:hanging");
            if (left)
                indentation.left = parseInt(left, 10);
            if (right)
                indentation.right = parseInt(right, 10);
            if (firstLine)
                indentation.firstLine = parseInt(firstLine, 10);
            if (hanging)
                indentation.hanging = parseInt(hanging, 10);
            return Object.keys(indentation).length > 0 ? indentation : undefined;
        }
        return undefined;
    };
    /**
     * Resolves mc:AlternateContent by preferring mc:Fallback if choice namespace is not recognized,
     * or simply the first available valid child.
     */
    const resolveAlternateContent = (element) => {
        const choice = (0, xmlUtils_js_1.getFirstElementByTagName)(element, "mc:Choice");
        // In most cases, mc:Choice contains the modern version, but mc:Fallback is safer for legacy compatibility
        // Mammoth often skips Choice if it's not handled. We'll try Choice first.
        if (choice)
            return Array.from(choice.childNodes);
        const fallback = (0, xmlUtils_js_1.getFirstElementByTagName)(element, "mc:Fallback");
        if (fallback)
            return Array.from(fallback.childNodes);
        return Array.from(element.childNodes);
    };
    const files = await (0, zipUtils_js_1.extractFiles)(buffer, x => !!x.match(documentFileRegex) ||
        !!x.match(footnotesFileRegex) ||
        !!x.match(endnotesFileRegex) ||
        !!x.match(numberingFileRegex) ||
        !!x.match(corePropsFileRegex) ||
        !!x.match(customPropsFileRegex) ||
        !!x.match(appPropsFileRegex) ||
        !!x.match(relsFileRegex) ||
        !!x.match(stylesFileRegex) ||
        (!config.ignoreComments && !!x.match(commentsFileRegex)) ||
        (!config.ignoreHeadersAndFooters && (!!x.match(headerFileRegex) || !!x.match(footerFileRegex))) ||
        (!!config.extractAttachments && !!x.match(mediaFileRegex)), config.decompressionLimits, config);
    // A DOCX without its main document part is not a DOCX. Checked with the same regex the
    // parse loop below uses to recognize it, so the two cannot fall out of step.
    (0, zipUtils_js_1.findRequiredPart)(files, path => !!path.match(documentFileRegex), config, { fileType: 'docx', part: 'word/document.xml' });
    // Extract metadata
    const corePropsFile = files.find(f => f.path.match(corePropsFileRegex));
    const metadata = corePropsFile ? (0, xmlUtils_js_1.parseOfficeMetadata)(corePropsFile.content.toString()) : {};
    const customPropsFile = files.find(f => f.path.match(customPropsFileRegex));
    if (customPropsFile) {
        const customProperties = (0, xmlUtils_js_1.parseOOXMLCustomProperties)(customPropsFile.content.toString());
        if (Object.keys(customProperties).length > 0)
            metadata.customProperties = customProperties;
    }
    const appPropsFile = files.find(f => f.path.match(appPropsFileRegex));
    if (appPropsFile) {
        const appProperties = (0, xmlUtils_js_1.parseOOXMLAppProperties)(appPropsFile.content.toString());
        if (Object.keys(appProperties).length > 0) {
            metadata.nativeProperties = appProperties;
            if (appProperties['Pages'] && typeof appProperties['Pages'] === 'number') {
                metadata.pages = appProperties['Pages'];
            }
        }
    }
    const footnoteMap = new Map();
    const endnoteMap = new Map();
    const commentMap = new Map();
    const commentMetadataMap = new Map();
    const attachments = [];
    const mediaFiles = files.filter(f => f.path.match(mediaFileRegex));
    // Extract relationships
    const relsFile = files.find(f => f.path.match(relsFileRegex));
    const relsMap = {};
    if (relsFile) {
        const relsXml = (0, xmlUtils_js_1.parseXmlString)(relsFile.content.toString());
        const relationships = (0, xmlUtils_js_1.getElementsByTagName)(relsXml, "Relationship");
        for (const relationship of relationships) {
            const id = relationship.getAttribute("Id");
            const target = relationship.getAttribute("Target");
            if (id && target) {
                relsMap[id] = target;
            }
        }
    }
    const numberingFile = files.find(f => f.path.match(numberingFileRegex));
    const numberingMap = {};
    if (numberingFile) {
        const numberingXml = (0, xmlUtils_js_1.parseXmlString)(numberingFile.content.toString());
        const nums = (0, xmlUtils_js_1.getElementsByTagName)(numberingXml, "w:num");
        const abstractNums = (0, xmlUtils_js_1.getElementsByTagName)(numberingXml, "w:abstractNum");
        const abstractNumMap = {};
        for (const abstractNum of abstractNums) {
            const abstractNumId = abstractNum.getAttribute("w:abstractNumId");
            if (abstractNumId) {
                abstractNumMap[abstractNumId] = abstractNum;
            }
        }
        for (const num of nums) {
            const numId = num.getAttribute("w:numId");
            const abstractNumIdNode = (0, xmlUtils_js_1.getFirstElementByTagName)(num, "w:abstractNumId");
            const abstractNumId = abstractNumIdNode?.getAttribute("w:val");
            if (numId && abstractNumId && abstractNumMap[abstractNumId]) {
                numberingMap[numId] = {};
                // Inherit from abstractNum
                const lvls = (0, xmlUtils_js_1.getElementsByTagName)(abstractNumMap[abstractNumId], "w:lvl");
                for (const lvl of lvls) {
                    const ilvl = lvl.getAttribute("w:ilvl");
                    const numFmtNode = (0, xmlUtils_js_1.getFirstElementByTagName)(lvl, "w:numFmt");
                    const lvlTextNode = (0, xmlUtils_js_1.getFirstElementByTagName)(lvl, "w:lvlText");
                    const startNode = (0, xmlUtils_js_1.getFirstElementByTagName)(lvl, "w:start");
                    if (ilvl) {
                        numberingMap[numId][ilvl] = {
                            numFmt: numFmtNode?.getAttribute("w:val") || 'decimal',
                            lvlText: lvlTextNode?.getAttribute("w:val") || '',
                            start: parseInt(startNode?.getAttribute("w:val") || '1', 10)
                        };
                    }
                }
                // Apply instance overrides (w:lvlOverride)
                const overrides = (0, xmlUtils_js_1.getElementsByTagName)(num, "w:lvlOverride");
                for (const override of overrides) {
                    const ilvl = override.getAttribute("w:ilvl");
                    if (ilvl && numberingMap[numId][ilvl]) {
                        const startOverride = (0, xmlUtils_js_1.getFirstElementByTagName)(override, "w:startOverride");
                        if (startOverride) {
                            numberingMap[numId][ilvl].start = parseInt(startOverride.getAttribute("w:val") || '1', 10);
                        }
                    }
                }
            }
        }
    }
    // Parse Styles
    const stylesFile = files.find(f => f.path.match(stylesFileRegex));
    const styleMap = {};
    if (stylesFile) {
        const stylesXml = (0, xmlUtils_js_1.parseXmlString)(stylesFile.content.toString());
        const styles = (0, xmlUtils_js_1.getElementsByTagName)(stylesXml, "w:style");
        for (const style of styles) {
            const styleId = style.getAttribute("w:styleId");
            if (styleId) {
                const rPr = (0, xmlUtils_js_1.getFirstElementByTagName)(style, "w:rPr");
                const pPr = (0, xmlUtils_js_1.getFirstElementByTagName)(style, "w:pPr");
                const formatting = rPr ? extractFormattingFromXml(rPr) : {};
                let alignment = undefined;
                let backgroundColor = undefined;
                let paragraphIndentation = undefined;
                if (pPr) {
                    const jc = (0, xmlUtils_js_1.getFirstElementByTagName)(pPr, "w:jc");
                    if (jc) {
                        const val = jc.getAttribute("w:val");
                        if (val === 'left' || val === 'center' || val === 'right' || val === 'justify') {
                            alignment = val;
                        }
                    }
                    const shd = (0, xmlUtils_js_1.getFirstElementByTagName)(pPr, "w:shd");
                    if (shd) {
                        const fill = shd.getAttribute("w:fill");
                        if (fill && fill !== 'auto')
                            backgroundColor = '#' + fill;
                    }
                    const ind = extractIndentationFromXml(pPr);
                    if (ind)
                        paragraphIndentation = ind;
                }
                styleMap[styleId] = { formatting, alignment, backgroundColor, paragraphIndentation };
            }
        }
    }
    // Extract document defaults
    let docDefaults = {};
    if (stylesFile) {
        const stylesXml = (0, xmlUtils_js_1.parseXmlString)(stylesFile.content.toString());
        const docDefaultsNode = (0, xmlUtils_js_1.getFirstElementByTagName)(stylesXml, "w:docDefaults");
        if (docDefaultsNode) {
            const rPrDefaultNode = (0, xmlUtils_js_1.getFirstElementByTagName)(docDefaultsNode, "w:rPrDefault");
            if (rPrDefaultNode) {
                const rPr = (0, xmlUtils_js_1.getFirstElementByTagName)(rPrDefaultNode, "w:rPr");
                if (rPr) {
                    docDefaults = extractFormattingFromXml(rPr);
                }
            }
        }
    }
    // Detect the default paragraph style (for international compatibility)
    let defaultParaStyleId = undefined;
    if (stylesFile) {
        const stylesXml = (0, xmlUtils_js_1.parseXmlString)(stylesFile.content.toString());
        const styles = (0, xmlUtils_js_1.getElementsByTagName)(stylesXml, "w:style");
        // Look for a style with w:type="paragraph" and w:default="1"
        for (const style of styles) {
            const styleType = style.getAttribute("w:type");
            const isDefault = style.getAttribute("w:default");
            const styleId = style.getAttribute("w:styleId");
            if (styleType === "paragraph" && isDefault === "1" && styleId) {
                defaultParaStyleId = styleId;
                break;
            }
        }
        // Fallback: if no default found, try "Normal"
        if (!defaultParaStyleId && styleMap["Normal"]) {
            defaultParaStyleId = "Normal";
        }
    }
    const content = [];
    const numberingState = {};
    const listCounters = {}; // Track item index per listId/level
    // Helper to parse a paragraph node
    const parseParagraph = (pNode, documentContent, pendingAnchorIds = []) => {
        // Check if it's a list item
        const numPr = (0, xmlUtils_js_1.getFirstElementByTagName)(pNode, "w:numPr");
        const isList = !!numPr;
        // Check if it's a heading
        const pPr = (0, xmlUtils_js_1.getFirstElementByTagName)(pNode, "w:pPr");
        const pStyle = pPr ? (0, xmlUtils_js_1.getFirstElementByTagName)(pPr, "w:pStyle") : null;
        const pStyleVal = pStyle?.getAttribute("w:val");
        const isHeading = pStyleVal ? (pStyleVal.startsWith("Heading") || pStyleVal === "Title") : false;
        // Extract Paragraph Style Properties
        const styleProps = pStyleVal && styleMap[pStyleVal] ? styleMap[pStyleVal] : { formatting: {} };
        // Extract Alignment
        let alignment = styleProps.alignment;
        if (pPr) {
            const jc = (0, xmlUtils_js_1.getFirstElementByTagName)(pPr, "w:jc");
            if (jc) {
                const val = jc.getAttribute("w:val");
                if (val === 'left' || val === 'center' || val === 'right' || val === 'justify') {
                    alignment = val;
                }
            }
        }
        // Extract Indentation
        let paraIndentation = styleProps.paragraphIndentation;
        if (pPr) {
            const ind = extractIndentationFromXml(pPr);
            if (ind) {
                paraIndentation = { ...paraIndentation, ...ind };
            }
        }
        // Extract Paragraph Background
        let paraBackgroundColor = styleProps.backgroundColor;
        if (pPr) {
            const shd = (0, xmlUtils_js_1.getFirstElementByTagName)(pPr, "w:shd");
            if (shd) {
                const fill = shd.getAttribute("w:fill");
                if (fill && fill !== 'auto') {
                    paraBackgroundColor = '#' + fill;
                }
            }
        }
        // Runs inherit their base formatting from the style chain: the paragraph style (seeded
        // here, and re-applied via the run-style path below), then any character style, then the
        // run's own properties. The paragraph-mark run properties (`<w:pPr><w:rPr>`) format only
        // the paragraph mark glyph itself per OOXML ISO 29500 §17.3.1.29, so they are deliberately
        // NOT folded into the run base - doing so bled the paragraph mark's bold/italic/color/etc.
        // onto every run in the paragraph (issue #109).
        const paragraphRunFormatting = { ...styleProps.formatting };
        // Extract text and children
        let text = '';
        const children = [];
        const notes = [];
        const comments = [];
        // Traverse children of paragraph (runs, hyperlinks, etc.)
        const processChildNode = (node) => {
            if ((0, xmlUtils_js_1.isElement)(node) && (node.nodeName === 'w:r' || node.nodeName === 'm:r')) {
                const runNode = node;
                const rPr = (0, xmlUtils_js_1.getFirstElementByTagName)(runNode, "w:rPr");
                // Formatting
                let formatting = {};
                // Apply paragraph-level formatting
                for (const key in paragraphRunFormatting) {
                    formatting[key] = paragraphRunFormatting[key];
                }
                // Check for run style
                const rStyle = rPr ? (0, xmlUtils_js_1.getFirstElementByTagName)(rPr, "w:rStyle") : null;
                const rStyleVal = rStyle ? rStyle.getAttribute("w:val") : pStyleVal;
                if (rStyleVal && styleMap[rStyleVal]) {
                    for (const key in styleMap[rStyleVal].formatting) {
                        formatting[key] = styleMap[rStyleVal].formatting[key];
                    }
                }
                // Apply direct run properties
                if (rPr) {
                    const directFormatting = extractFormattingFromXml(rPr);
                    for (const key in directFormatting) {
                        const value = directFormatting[key];
                        if (value === false) {
                            delete formatting[key];
                        }
                        else if (value !== undefined) {
                            formatting[key] = value;
                        }
                    }
                }
                // Inherit paragraph background
                if (!formatting.backgroundColor && paraBackgroundColor) {
                    formatting.backgroundColor = paraBackgroundColor;
                }
                for (const child of runNode.childNodes) {
                    if (!(0, xmlUtils_js_1.isElement)(child))
                        continue;
                    // also handle unprefixed version (mirroring the behaviour of getElementsByTagName)
                    // Text content
                    if (child.tagName === "w:t" || child.tagName === "t" || child.tagName === "m:t") {
                        const tNode = child;
                        const tContent = tNode.textContent || '';
                        text += tContent;
                        const textNode = {
                            type: 'text',
                            text: tContent,
                            formatting: formatting
                        };
                        if (config.includeRawContent) {
                            textNode.rawContent = (0, xmlUtils_js_1.getRawContent)(tNode, documentContent, config);
                        }
                        // Always set a style: run style > paragraph style > detected default
                        // Use detected default style for international compatibility
                        const nodeStyle = rStyleVal || pStyleVal || defaultParaStyleId;
                        if (nodeStyle) {
                            textNode.metadata = { style: nodeStyle };
                        }
                        children.push(textNode);
                    }
                    // Break nodes
                    else if (config.includeBreakNodes &&
                        (child.tagName === "w:br"
                            || child.tagName === "br"
                            || child.tagName === "w:cr"
                            || child.tagName === "cr")) {
                        const brNode = child;
                        let breakType = 'textWrapping';
                        if (child.tagName === "w:cr" || child.tagName === "cr") {
                            breakType = 'carriageReturn';
                        }
                        else {
                            const nodeBreakType = brNode.getAttribute("w:type") || brNode.getAttribute("type");
                            if (nodeBreakType !== null) {
                                breakType = nodeBreakType;
                            }
                        }
                        let breakClear = undefined;
                        if (breakType === 'textWrapping' && brNode.getAttribute("w:clear") !== null) {
                            breakClear = brNode.getAttribute("w:clear");
                        }
                        const breakNode = {
                            type: 'break',
                            metadata: { breakType, clear: breakClear }
                        };
                        if (config.includeRawContent) {
                            breakNode.rawContent = (0, xmlUtils_js_1.getRawContent)(brNode, documentContent, config);
                        }
                        children.push(breakNode);
                    }
                    else if (config.includeBreakNodes && (child.tagName === "w:lastRenderedPageBreak" || child.tagName === "lastRenderedPageBreak")) {
                        const breakNode = {
                            type: 'break',
                            metadata: { breakType: 'lastRenderedPage' }
                        };
                        if (config.includeRawContent) {
                            breakNode.rawContent = (0, xmlUtils_js_1.getRawContent)(child, documentContent, config);
                        }
                        children.push(breakNode);
                    }
                }
                // Images/Drawings
                if (config.extractAttachments) {
                    const drawings = (0, xmlUtils_js_1.getElementsByTagName)(runNode, "w:drawing");
                    const picts = (0, xmlUtils_js_1.getElementsByTagName)(runNode, "w:pict");
                    const allImages = [...drawings, ...picts];
                    for (const imgNode of allImages) {
                        const imgXml = (0, xmlUtils_js_1.serializeXml)(imgNode);
                        // Extract Alt Text
                        let altText = '';
                        const docPr = (0, xmlUtils_js_1.getFirstElementByTagName)(imgNode, "wp:docPr");
                        if (docPr) {
                            altText = docPr.getAttribute("descr") || docPr.getAttribute("title") || '';
                        }
                        // Extract Relationship ID
                        let rId = '';
                        const blip = (0, xmlUtils_js_1.getFirstElementByTagName)(imgNode, "a:blip");
                        if (blip) {
                            rId = blip.getAttribute("r:embed") || '';
                        }
                        else {
                            const imagedata = (0, xmlUtils_js_1.getFirstElementByTagName)(imgNode, "v:imagedata");
                            if (imagedata) {
                                rId = imagedata.getAttribute("r:id") || '';
                            }
                        }
                        if (rId && relsMap[rId]) {
                            const target = relsMap[rId];
                            const filename = target.split('/').pop();
                            if (filename) {
                                const imageNode = {
                                    type: 'image',
                                    text: '',
                                    metadata: { attachmentName: filename, altText: altText }
                                };
                                if (config.includeRawContent) {
                                    imageNode.rawContent = (0, xmlUtils_js_1.getRawContent)(imgNode, documentContent, config);
                                }
                                children.push(imageNode);
                            }
                        }
                        else {
                            const imageNode = {
                                type: 'image',
                                text: '',
                            };
                            if (config.includeRawContent) {
                                imageNode.rawContent = (0, xmlUtils_js_1.getRawContent)(imgNode, documentContent, config);
                            }
                            children.push(imageNode);
                        }
                    }
                }
                // Footnotes/Endnotes inside runs
                if (!config.ignoreNotes) {
                    const footnoteRef = (0, xmlUtils_js_1.getFirstElementByTagName)(runNode, "w:footnoteReference");
                    if (footnoteRef) {
                        const id = footnoteRef.getAttribute("w:id");
                        if (id && footnoteMap.has(id)) {
                            const noteNodes = footnoteMap.get(id);
                            const noteNode = {
                                type: 'note',
                                text: noteNodes.map((n) => n.text).join(' '),
                                children: noteNodes,
                                metadata: { noteType: 'footnote', noteId: id }
                            };
                            if (children.length > 0) {
                                const target = children[children.length - 1];
                                if (!target.notes)
                                    target.notes = [];
                                target.notes.push(noteNode);
                            }
                            else {
                                notes.push(noteNode);
                            }
                        }
                    }
                    const endnoteRef = (0, xmlUtils_js_1.getFirstElementByTagName)(runNode, "w:endnoteReference");
                    if (endnoteRef) {
                        const id = endnoteRef.getAttribute("w:id");
                        if (id && endnoteMap.has(id)) {
                            const noteNodes = endnoteMap.get(id);
                            const noteNode = {
                                type: 'note',
                                text: noteNodes.map((n) => n.text).join(' '),
                                children: noteNodes,
                                metadata: { noteType: 'endnote', noteId: id }
                            };
                            if (children.length > 0) {
                                const target = children[children.length - 1];
                                if (!target.notes)
                                    target.notes = [];
                                target.notes.push(noteNode);
                            }
                            else {
                                notes.push(noteNode);
                            }
                        }
                    }
                }
                // Comments inside runs
                if (!config.ignoreComments) {
                    const commentRef = (0, xmlUtils_js_1.getFirstElementByTagName)(runNode, "w:commentReference");
                    if (commentRef) {
                        const id = commentRef.getAttribute("w:id");
                        if (id && commentMap.has(id)) {
                            const commentNodes = commentMap.get(id);
                            const commentInfo = commentMetadataMap.get(id);
                            const commentNode = {
                                type: 'comment',
                                text: commentNodes.map((n) => n.text).join(' '),
                                children: commentNodes,
                                metadata: commentInfo || { commentId: id }
                            };
                            if (children.length > 0) {
                                const target = children[children.length - 1];
                                if (!target.comments)
                                    target.comments = [];
                                target.comments.push(commentNode);
                            }
                            else {
                                comments.push(commentNode);
                            }
                        }
                    }
                }
            }
            else if ((0, xmlUtils_js_1.isElement)(node) && node.nodeName === 'w:hyperlink') {
                const hlNode = node;
                const rId = hlNode.getAttribute("r:id");
                const anchor = hlNode.getAttribute("w:anchor");
                let linkMetadata;
                if (anchor && !config.ignoreInternalLinks) {
                    linkMetadata = { link: '#' + anchor, linkType: 'internal' };
                }
                else if (rId && relsMap[rId]) {
                    linkMetadata = { link: relsMap[rId], linkType: 'external' };
                }
                // Process children of hyperlink (usually runs)
                const hlChildren = Array.from(hlNode.childNodes);
                for (const child of hlChildren) {
                    // Capture the current length of children to apply metadata to new nodes
                    const startIndex = children.length;
                    processChildNode(child);
                    // Apply link metadata to the newly added text nodes
                    if (linkMetadata) {
                        for (let i = startIndex; i < children.length; i++) {
                            if (children[i].type === 'text') {
                                children[i].metadata = { ...(children[i].metadata ?? {}), ...linkMetadata };
                            }
                        }
                    }
                }
            }
            else if ((0, xmlUtils_js_1.isElement)(node) && node.nodeName === 'w:bookmarkStart') {
                const bookmarkName = node.getAttribute("w:name");
                if (bookmarkName && !bookmarkName.startsWith('_GoBack') && !config.ignoreInternalLinks) {
                    anchorIds.push(bookmarkName);
                }
            }
            else if ((0, xmlUtils_js_1.isElement)(node) && (node.nodeName === 'mc:AlternateContent' || node.nodeName === 'AlternateContent')) {
                const resolved = resolveAlternateContent(node);
                for (const rNode of resolved)
                    processChildNode(rNode);
            }
            else if ((0, xmlUtils_js_1.isElement)(node) && (node.nodeName === 'w:pict' || node.nodeName === 'pict' || node.nodeName === 'w:drawing' || node.nodeName === 'drawing')) {
                // Extract text boxes from legacy shapes or modern drawings
                const textBoxes = (0, xmlUtils_js_1.getElementsByTagName)(node, "w:txbxContent");
                for (const txbx of textBoxes) {
                    const txbxChildren = Array.from(txbx.childNodes);
                    for (const txbxChild of txbxChildren) {
                        if ((0, xmlUtils_js_1.isElement)(txbxChild) && txbxChild.nodeName === 'w:p') {
                            const nestedP = parseParagraph(txbxChild, documentContent);
                            children.push(...(nestedP.children || []));
                            text += nestedP.text;
                        }
                    }
                }
            }
            else if ((0, xmlUtils_js_1.isElement)(node) && (node.nodeName === 'm:oMath' || node.nodeName === 'oMath'
                || node.nodeName === 'm:oMathPara' || node.nodeName === 'oMathPara')) {
                // Equations. Without this branch they reach the generic fallback below, which
                // recurses into every child and concatenates the `m:t` runs with no separators -
                // so `<m:num>1</m:num><m:den>2</m:den>` came out as "12". That is worse than
                // dropping the formula: the result still reads as a number, so nothing downstream
                // can tell it is wrong.
                //
                // `m:oMathPara` is a display equation on its own line; a bare `m:oMath` is inline.
                const isBlock = node.nodeName === 'm:oMathPara' || node.nodeName === 'oMathPara';
                const latex = (0, mathUtils_js_1.ommlToLatex)(node);
                if (!(0, mathUtils_js_1.isEmptyMath)(latex)) {
                    text += latex;
                    children.push({
                        type: 'code',
                        text: latex,
                        metadata: { math: isBlock ? 'block' : 'inline' }
                    });
                }
            }
            else if (node.childNodes.length > 0) {
                // Generic fallback for unknown elements that might contain content
                for (const child of Array.from(node.childNodes))
                    processChildNode(child);
            }
        };
        const anchorIds = [...pendingAnchorIds];
        const childNodes = Array.from(pNode.childNodes);
        for (const child of childNodes) {
            processChildNode(child);
        }
        const commonMetadata = anchorIds.length > 0 ? { anchorIds } : {};
        if (isList) {
            const numIdNode = (0, xmlUtils_js_1.getFirstElementByTagName)(numPr, "w:numId");
            const ilvlNode = (0, xmlUtils_js_1.getFirstElementByTagName)(numPr, "w:ilvl");
            const numId = numIdNode ? numIdNode.getAttribute("w:val") || '0' : '0';
            const ilvl = ilvlNode ? parseInt(ilvlNode.getAttribute("w:val") || '0', 10) : 0;
            let listType = 'ordered';
            let itemIndex = 0;
            if (numId && numberingMap[numId]) {
                const ilvlStr = ilvl.toString();
                if (!numberingState[numId])
                    numberingState[numId] = {};
                if (!numberingState[numId][ilvlStr])
                    numberingState[numId][ilvlStr] = 0;
                numberingState[numId][ilvlStr]++;
                for (let k = ilvl + 1; k < 10; k++) {
                    if (numberingState[numId][k.toString()])
                        numberingState[numId][k.toString()] = 0;
                }
                const numFmt = numberingMap[numId][ilvlStr]?.numFmt || 'decimal';
                listType = numFmt === 'bullet' ? 'unordered' : 'ordered';
                // Track itemIndex (starts at override or default, continues across interruptions for same listId)
                if (!listCounters[numId])
                    listCounters[numId] = {};
                if (listCounters[numId][ilvlStr] === undefined) {
                    listCounters[numId][ilvlStr] = (numberingMap[numId][ilvlStr]?.start ?? 1) - 1;
                }
                else {
                    listCounters[numId][ilvlStr]++;
                }
                itemIndex = listCounters[numId][ilvlStr];
            }
            const listNode = {
                type: 'list',
                text: text,
                children: children,
                ...(notes.length > 0 ? { notes } : {}),
                ...(comments.length > 0 ? { comments } : {}),
                metadata: {
                    listType,
                    indentation: ilvl,
                    paragraphIndentation: paraIndentation,
                    alignment: (alignment || 'left'),
                    listId: numId,
                    itemIndex: itemIndex,
                    style: pStyleVal,
                    ...commonMetadata
                }
            };
            if (config.includeRawContent)
                listNode.rawContent = (0, xmlUtils_js_1.getRawContent)(pNode, documentContent, config);
            return listNode;
        }
        else if (isHeading) {
            const level = pStyleVal ? parseInt(pStyleVal.replace("Heading", ""), 10) || 1 : 1;
            const headingNode = {
                type: 'heading',
                text: text,
                children: children,
                ...(notes.length > 0 ? { notes } : {}),
                ...(comments.length > 0 ? { comments } : {}),
                metadata: { level, alignment, paragraphIndentation: paraIndentation, style: pStyleVal ?? undefined, ...commonMetadata }
            };
            if (config.includeRawContent)
                headingNode.rawContent = (0, xmlUtils_js_1.getRawContent)(pNode, documentContent, config);
            return headingNode;
        }
        else {
            const paraNode = {
                type: 'paragraph',
                text: text,
                children: children,
                ...(notes.length > 0 ? { notes } : {}),
                ...(comments.length > 0 ? { comments } : {}),
                metadata: { alignment, paragraphIndentation: paraIndentation, style: pStyleVal ?? undefined, ...commonMetadata }
            };
            if (config.includeRawContent)
                paraNode.rawContent = (0, xmlUtils_js_1.getRawContent)(pNode, documentContent, config);
            return paraNode;
        }
    };
    // Helper to parse a table node
    const parseTable = (tblNode, documentContent, pendingAnchorIds = []) => {
        const rows = [];
        const trNodes = (0, xmlUtils_js_1.getDirectChildren)(tblNode, "w:tr");
        // Track vertical merges: colIndex -> { startCellNode, rowSpan }
        const vMergeMap = new Map();
        for (let rIndex = 0; rIndex < trNodes.length; rIndex++) {
            const trNode = trNodes[rIndex];
            const cells = [];
            // Only get direct child cells, not nested table cells
            const tcNodes = (0, xmlUtils_js_1.getDirectChildren)(trNode, "w:tc");
            let visualCol = 0;
            for (let tcIndex = 0; tcIndex < tcNodes.length; tcIndex++) {
                const tcNode = tcNodes[tcIndex];
                const tcPr = (0, xmlUtils_js_1.getFirstElementByTagName)(tcNode, "w:tcPr");
                // Horizontal merge (colspan)
                let colSpan = 1;
                if (tcPr) {
                    const gridSpan = (0, xmlUtils_js_1.getFirstElementByTagName)(tcPr, "w:gridSpan");
                    if (gridSpan) {
                        colSpan = parseInt(gridSpan.getAttribute("w:val") || "1", 10);
                    }
                }
                let vMergeRestart = false;
                let isVMerge = false;
                if (tcPr) {
                    const vMerge = (0, xmlUtils_js_1.getFirstElementByTagName)(tcPr, "w:vMerge");
                    if (vMerge) {
                        isVMerge = true;
                        const val = vMerge.getAttribute("w:val");
                        // If it's explicit restart, or if we don't have an active merge for this column, treat as restart
                        if (val === "restart" || !vMergeMap.has(visualCol)) {
                            vMergeRestart = true;
                        }
                    }
                }
                const cellChildren = [];
                let cellText = '';
                // Cells contain paragraphs (and other block-level elements)
                const cellContentNodes = Array.from(tcNode.childNodes);
                for (const child of cellContentNodes) {
                    if ((0, xmlUtils_js_1.isElement)(child) && child.nodeName === 'w:p') {
                        const pNode = parseParagraph(child, documentContent);
                        cellChildren.push(pNode);
                        cellText += pNode.text;
                    }
                    else if ((0, xmlUtils_js_1.isElement)(child) && child.nodeName === 'w:tbl') {
                        const nestedTable = parseTable(child, documentContent);
                        cellChildren.push(nestedTable);
                    }
                }
                const cellNode = {
                    type: 'cell',
                    text: cellText,
                    children: cellChildren,
                    metadata: { row: rIndex, col: visualCol }
                };
                if (colSpan > 1)
                    cellNode.metadata.colSpan = colSpan;
                if (tcPr) {
                    const shd = (0, xmlUtils_js_1.getFirstElementByTagName)(tcPr, "w:shd");
                    if (shd) {
                        const fill = shd.getAttribute("w:fill");
                        if (fill && fill !== "auto") {
                            cellNode.metadata.backgroundColor = "#" + fill;
                        }
                    }
                }
                if (isVMerge) {
                    if (vMergeRestart) {
                        vMergeMap.set(visualCol, { node: cellNode, span: 1 });
                        cells.push(cellNode);
                    }
                    else {
                        const mergeInfo = vMergeMap.get(visualCol);
                        if (mergeInfo) {
                            mergeInfo.span++;
                            mergeInfo.node.metadata.rowSpan = mergeInfo.span;
                            if (cellChildren.length > 0) {
                                if (!mergeInfo.node.children)
                                    mergeInfo.node.children = [];
                                mergeInfo.node.children.push(...cellChildren);
                                mergeInfo.node.text += " " + cellText;
                            }
                        }
                        else {
                            // Fallback: if we found a continue but no restart, treat as normal cell
                            cells.push(cellNode);
                        }
                    }
                }
                else {
                    vMergeMap.delete(visualCol);
                    cells.push(cellNode);
                }
                visualCol += colSpan;
            }
            const rowNode = {
                type: 'row',
                children: cells,
            };
            rows.push(rowNode);
        }
        return {
            type: 'table',
            children: rows
        };
    };
    // Pre-process footnotes and endnotes to be inserted inline later
    if (!config.ignoreNotes) {
        const footnotesFile = files.find(f => f.path.match(footnotesFileRegex));
        if (footnotesFile) {
            const footnotesDoc = (0, xmlUtils_js_1.parseXmlString)(footnotesFile.content.toString());
            const footnoteXml = footnotesFile.content.toString();
            const footnoteNodes = (0, xmlUtils_js_1.getElementsByTagName)(footnotesDoc, "w:footnote");
            for (const node of footnoteNodes) {
                const id = node.getAttribute("w:id");
                if (!id || id === "-1" || id === "0")
                    continue;
                const pNodes = (0, xmlUtils_js_1.getElementsByTagName)(node, "w:p");
                footnoteMap.set(id, pNodes.map(p => parseParagraph(p, footnoteXml)));
            }
        }
        const endnotesFile = files.find(f => f.path.match(endnotesFileRegex));
        if (endnotesFile) {
            const endnotesDoc = (0, xmlUtils_js_1.parseXmlString)(endnotesFile.content.toString());
            const endnoteXml = endnotesFile.content.toString();
            const endnoteNodes = (0, xmlUtils_js_1.getElementsByTagName)(endnotesDoc, "w:endnote");
            for (const node of endnoteNodes) {
                const id = node.getAttribute("w:id");
                if (!id || id === "-1" || id === "0")
                    continue;
                const pNodes = (0, xmlUtils_js_1.getElementsByTagName)(node, "w:p");
                endnoteMap.set(id, pNodes.map(p => parseParagraph(p, endnoteXml)));
            }
        }
    }
    // Pre-process comments
    if (!config.ignoreComments) {
        const commentsFile = files.find(f => f.path.match(commentsFileRegex));
        if (commentsFile) {
            const commentsDoc = (0, xmlUtils_js_1.parseXmlString)(commentsFile.content.toString());
            const commentsXml = commentsFile.content.toString();
            const commentNodes = (0, xmlUtils_js_1.getElementsByTagName)(commentsDoc, "w:comment");
            for (const node of commentNodes) {
                const id = node.getAttribute("w:id");
                if (!id)
                    continue;
                const author = node.getAttribute("w:author") || undefined;
                const date = node.getAttribute("w:date") || undefined;
                const initials = node.getAttribute("w:initials") || undefined;
                commentMetadataMap.set(id, { commentId: id, author, date, initials });
                const pNodes = (0, xmlUtils_js_1.getElementsByTagName)(node, "w:p");
                commentMap.set(id, pNodes.map(p => parseParagraph(p, commentsXml)));
            }
        }
    }
    // Pre-process headers and footers
    const headers = [];
    const footers = [];
    if (!config.ignoreHeadersAndFooters) {
        const headerFiles = files.filter(f => f.path.match(headerFileRegex));
        for (const hFile of headerFiles) {
            const hDoc = (0, xmlUtils_js_1.parseXmlString)(hFile.content.toString());
            const hXml = hFile.content.toString();
            const hNodes = Array.from(hDoc.documentElement.childNodes).filter(xmlUtils_js_1.isElement);
            for (const child of hNodes) {
                if (child.nodeName === 'w:p')
                    headers.push(parseParagraph(child, hXml));
                else if (child.nodeName === 'w:tbl')
                    headers.push(parseTable(child, hXml));
                else if (child.nodeName === 'w:sdt') {
                    const contentNode = (0, xmlUtils_js_1.getFirstElementByTagName)(child, "w:sdtContent");
                    if (contentNode) {
                        for (const sdtChild of Array.from(contentNode.childNodes).filter(xmlUtils_js_1.isElement)) {
                            if (sdtChild.nodeName === 'w:p')
                                headers.push(parseParagraph(sdtChild, hXml));
                            else if (sdtChild.nodeName === 'w:tbl')
                                headers.push(parseTable(sdtChild, hXml));
                        }
                    }
                }
            }
        }
        const footerFiles = files.filter(f => f.path.match(footerFileRegex));
        for (const fFile of footerFiles) {
            const fDoc = (0, xmlUtils_js_1.parseXmlString)(fFile.content.toString());
            const fXml = fFile.content.toString();
            const fNodes = Array.from(fDoc.documentElement.childNodes).filter(xmlUtils_js_1.isElement);
            for (const child of fNodes) {
                if (child.nodeName === 'w:p')
                    footers.push(parseParagraph(child, fXml));
                else if (child.nodeName === 'w:tbl')
                    footers.push(parseTable(child, fXml));
                else if (child.nodeName === 'w:sdt') {
                    const contentNode = (0, xmlUtils_js_1.getFirstElementByTagName)(child, "w:sdtContent");
                    if (contentNode) {
                        for (const sdtChild of Array.from(contentNode.childNodes).filter(xmlUtils_js_1.isElement)) {
                            if (sdtChild.nodeName === 'w:p')
                                footers.push(parseParagraph(sdtChild, fXml));
                            else if (sdtChild.nodeName === 'w:tbl')
                                footers.push(parseTable(sdtChild, fXml));
                        }
                    }
                }
            }
        }
    }
    for (const file of files) {
        if (file.path.match(mediaFileRegex))
            continue;
        if (file.path.match(numberingFileRegex))
            continue;
        if (file.path.match(relsFileRegex))
            continue;
        if (file.path.match(stylesFileRegex))
            continue;
        if (file.path.match(footnotesFileRegex))
            continue;
        if (file.path.match(endnotesFileRegex))
            continue;
        if (file.path.match(commentsFileRegex))
            continue;
        if (file.path.match(headerFileRegex))
            continue;
        if (file.path.match(footerFileRegex))
            continue;
        const documentContent = file.content.toString();
        const doc = (0, xmlUtils_js_1.parseXmlString)(documentContent, { locator: config.includeRawContent });
        const body = (0, xmlUtils_js_1.getFirstElementByTagName)(doc, "w:body");
        if (body) {
            const bodyChildren = Array.from(body.childNodes);
            let pendingAnchorIds = [];
            for (const child of bodyChildren) {
                (0, errorUtils_js_1.checkAbortSignal)(config.abortSignal);
                if ((0, xmlUtils_js_1.isElement)(child)) {
                    if (child.nodeName === 'w:p') {
                        content.push(parseParagraph(child, documentContent, pendingAnchorIds));
                        pendingAnchorIds = [];
                    }
                    else if (child.nodeName === 'w:tbl') {
                        content.push(parseTable(child, documentContent, pendingAnchorIds));
                        pendingAnchorIds = [];
                    }
                    else if (child.nodeName === 'w:bookmarkStart') {
                        const bookmarkName = child.getAttribute("w:name");
                        if (bookmarkName && !bookmarkName.startsWith('_GoBack') && !config.ignoreInternalLinks) {
                            pendingAnchorIds.push(bookmarkName);
                        }
                    }
                }
            }
        }
    }
    // Extract attachments
    if (config.extractAttachments) {
        for (const media of mediaFiles) {
            const attachment = (0, imageUtils_js_1.createAttachment)(media.path.split('/').pop() || 'image', media.content);
            attachments.push(attachment);
            if (config.ocr) {
                if (attachment.mimeType.startsWith('image/')) {
                    try {
                        attachment.ocrText = (await (0, ocrUtils_js_1.performOcr)(media.content, { ...config.ocrConfig })).trim();
                    }
                    catch (e) {
                        (0, errorUtils_js_1.logWarning)(types_js_1.OfficeWarningType.OCR_FAILED, config, attachment.name, e);
                    }
                }
            }
        }
        // Assign OCR text to image nodes
        if (config.ocr) {
            const assignOcr = (nodes) => {
                for (const node of nodes) {
                    if (node.type === 'image' && 'attachmentName' in (node.metadata || {})) {
                        const meta = node.metadata;
                        const attachment = attachments.find(a => a.name === meta.attachmentName);
                        if (attachment && attachment.ocrText) {
                            node.text = attachment.ocrText;
                            attachment.altText = meta.altText;
                        }
                    }
                    if (node.children) {
                        assignOcr(node.children);
                    }
                }
            };
            assignOcr(content);
        }
    }
    const toTextSync = () => content.map(c => {
        // Recursive text extraction
        const getText = (node) => {
            let t = '';
            if (node.children) {
                t += node.children.map(getText).filter(t => t != '').join(!node.children[0]?.children ? '' : config.newlineDelimiter);
            }
            else if (node.type === 'break') {
                t += config.newlineDelimiter;
            }
            else
                t += node.text || '';
            return t;
        };
        return getText(c);
    }).filter(t => t != '').join(config.newlineDelimiter);
    const auxiliaryContent = (headers.length > 0 || footers.length > 0) ? {
        ...(headers.length > 0 ? { headers } : {}),
        ...(footers.length > 0 ? { footers } : {})
    } : undefined;
    return (0, astUtils_js_1.createAST)('docx', { ...metadata, formatting: docDefaults, styleMap: styleMap }, content, attachments, config, auxiliaryContent, toTextSync);
};
exports.parseWord = parseWord;
