"use strict";
/**
 * Excel Spreadsheet (XLSX) Parser
 *
 * **XLSX Format Overview:**
 * XLSX is the default format for Microsoft Excel since Office 2007, based on OOXML.
 *
 * **File Structure:**
 * - `xl/workbook.xml` - Workbook structure and sheet list
 * - `xl/worksheets/sheet1.xml` - Individual sheet data
 * - `xl/sharedStrings.xml` - Shared string table (cell text)
 * - `xl/styles.xml` - Cell styling information
 * - `xl/drawings/*` - Charts and drawings
 * - `xl/media/*` - Embedded images
 *
 * **Key Elements:**
 * - `<row>` - Table row with row index
 * - `<c r="A1">` - Cell with reference (A1, B2, etc.)
 * - `<v>` - Cell value (number or shared string index)
 * - `<t="s">` - Cell type (s=string, n=number, b=boolean)
 *
 * @module ExcelParser
 * @see https://www.ecma-international.org/publications-and-standards/standards/ecma-376/
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseExcel = void 0;
const types_js_1 = require("../types.js");
const astUtils_js_1 = require("../utils/astUtils.js");
const chartUtils_js_1 = require("../utils/chartUtils.js");
const errorUtils_js_1 = require("../utils/errorUtils.js");
const imageUtils_js_1 = require("../utils/imageUtils.js");
const ocrUtils_js_1 = require("../utils/ocrUtils.js");
const xmlUtils_js_1 = require("../utils/xmlUtils.js");
const zipUtils_js_1 = require("../utils/zipUtils.js");
/**
 * Parses an Excel spreadsheet (.xlsx) and extracts sheets, rows, and cells.
 *
 * @param buffer - The XLSX file as a Buffer
 * @param config - Parser configuration
 * @returns A promise resolving to the parsed AST
 */
const parseExcel = async (buffer, config) => {
    // Honour cancellation requests immediately — before extracting the ZIP archive.
    // XLSX parsing involves decompressing multiple XML sheets and potentially running OCR
    // on embedded chart images, so short-circuiting here saves significant work.
    (0, errorUtils_js_1.checkAbortSignal)(config.abortSignal);
    const sheetsRegex = /xl\/worksheets\/sheet\d+.xml/g;
    const drawingsRegex = /xl\/drawings\/drawing\d+.xml/g;
    const chartsRegex = /xl\/charts\/chart\d+.xml/g;
    const stringsFilePath = 'xl/sharedStrings.xml';
    const mediaFileRegex = /xl\/media\/.*/;
    const corePropsFileRegex = /docProps\/core\.xml/;
    const customPropsFileRegex = /docProps\/custom\.xml/;
    const appPropsFileRegex = /docProps\/app\.xml/;
    const relsRegex = /xl\/worksheets\/_rels\/sheet\d+\.xml\.rels/g;
    const drawingRelsRegex = /xl\/drawings\/_rels\/drawing\d+\.xml\.rels/g;
    const commentsRegex = /xl\/comments\d+\.xml/g;
    const files = await (0, zipUtils_js_1.extractFiles)(buffer, (x) => !!x.match(sheetsRegex) ||
        !!x.match(drawingsRegex) ||
        !!x.match(chartsRegex) ||
        (!config.ignoreComments && !!x.match(commentsRegex)) ||
        x === stringsFilePath ||
        x === 'xl/styles.xml' ||
        x === 'xl/workbook.xml' ||
        x === 'xl/_rels/workbook.xml.rels' ||
        !!x.match(corePropsFileRegex) ||
        !!x.match(customPropsFileRegex) ||
        !!x.match(appPropsFileRegex) ||
        (!!config.extractAttachments && (!!x.match(mediaFileRegex) || !!x.match(drawingRelsRegex))) ||
        ((!!config.extractAttachments || !config.ignoreComments) && !!x.match(relsRegex)), config.decompressionLimits, config);
    // Every workbook has xl/workbook.xml; without it the archive is not a spreadsheet.
    // Resolved up front so a file that cannot be a workbook fails before any of the parsing
    // work below, and read again further down for the sheet-name map.
    const workbookFile = (0, zipUtils_js_1.findRequiredPart)(files, path => path === 'xl/workbook.xml', config, { fileType: 'xlsx', part: 'xl/workbook.xml' });
    // Worksheets, by contrast, are not guaranteed: a workbook holding only chartsheets is
    // valid and simply has no cell text to extract. Warn rather than fail, so the caller can
    // tell "nothing to read here" from "we read nothing".
    if (!files.some(file => !!file.path.match(sheetsRegex)))
        (0, errorUtils_js_1.logWarning)(types_js_1.OfficeWarningType.NO_WORKSHEETS_FOUND, config);
    const sharedStringsFile = files.find(f => f.path === stringsFilePath);
    // Updated to store structured content (rich text runs) or simple string
    const sharedStrings = [];
    if (sharedStringsFile) {
        const xml = (0, xmlUtils_js_1.parseXmlString)(sharedStringsFile.content.toString());
        const siNodes = (0, xmlUtils_js_1.getElementsByTagName)(xml, "si");
        for (const si of siNodes) {
            const runNodes = (0, xmlUtils_js_1.getElementsByTagName)(si, "r");
            if (runNodes.length > 0) {
                // Rich text with runs
                const runs = [];
                for (const run of runNodes) {
                    const tNode = (0, xmlUtils_js_1.getElementsByTagName)(run, "t")[0];
                    if (tNode) {
                        const text = tNode.textContent || '';
                        // Extract run formatting 
                        const rPr = (0, xmlUtils_js_1.getElementsByTagName)(run, "rPr")[0];
                        const formatting = {};
                        if (rPr) {
                            if ((0, xmlUtils_js_1.getElementsByTagName)(rPr, "b").length > 0)
                                formatting.bold = true;
                            if ((0, xmlUtils_js_1.getElementsByTagName)(rPr, "i").length > 0)
                                formatting.italic = true;
                            if ((0, xmlUtils_js_1.getElementsByTagName)(rPr, "u").length > 0)
                                formatting.underline = true;
                            if ((0, xmlUtils_js_1.getElementsByTagName)(rPr, "strike").length > 0)
                                formatting.strikethrough = true;
                            const sz = (0, xmlUtils_js_1.getElementsByTagName)(rPr, "sz")[0];
                            if (sz)
                                formatting.size = sz.getAttribute("val") + 'pt';
                            const color = (0, xmlUtils_js_1.getElementsByTagName)(rPr, "color")[0];
                            if (color) {
                                const rgb = color.getAttribute("rgb");
                                if (rgb)
                                    formatting.color = '#' + rgb.substring(2);
                            }
                            const rFont = (0, xmlUtils_js_1.getElementsByTagName)(rPr, "rFont")[0];
                            if (rFont)
                                formatting.font = rFont.getAttribute("val") || undefined;
                            const vertAlign = (0, xmlUtils_js_1.getElementsByTagName)(rPr, "vertAlign")[0];
                            if (vertAlign) {
                                const val = vertAlign.getAttribute("val");
                                if (val === "subscript")
                                    formatting.subscript = true;
                                if (val === "superscript")
                                    formatting.superscript = true;
                            }
                        }
                        runs.push({
                            type: 'text',
                            text: text,
                            formatting: Object.keys(formatting).length > 0 ? formatting : undefined
                        });
                    }
                }
                sharedStrings.push(runs);
            }
            else {
                // Simple text case
                const tNodes = (0, xmlUtils_js_1.getElementsByTagName)(si, "t");
                let text = '';
                for (const t of tNodes) {
                    text += t.textContent || '';
                }
                sharedStrings.push(text);
            }
        }
    }
    // Parse styles to build formatting map
    const stylesFile = files.find(f => f.path === 'xl/styles.xml');
    const cellFormatMap = {};
    if (stylesFile) {
        const xml = (0, xmlUtils_js_1.parseXmlString)(stylesFile.content.toString());
        // Parse fonts
        const fontsNode = (0, xmlUtils_js_1.getElementsByTagName)(xml, "fonts")[0];
        const fonts = [];
        if (fontsNode) {
            const fontNodes = (0, xmlUtils_js_1.getElementsByTagName)(fontsNode, "font");
            for (const font of fontNodes) {
                const formatting = {};
                if ((0, xmlUtils_js_1.getElementsByTagName)(font, "b").length > 0)
                    formatting.bold = true;
                if ((0, xmlUtils_js_1.getElementsByTagName)(font, "i").length > 0)
                    formatting.italic = true;
                if ((0, xmlUtils_js_1.getElementsByTagName)(font, "u").length > 0)
                    formatting.underline = true;
                if ((0, xmlUtils_js_1.getElementsByTagName)(font, "strike").length > 0)
                    formatting.strikethrough = true;
                const szNode = (0, xmlUtils_js_1.getElementsByTagName)(font, "sz")[0];
                if (szNode) {
                    const val = szNode.getAttribute("val");
                    if (val)
                        formatting.size = val + 'pt';
                }
                const colorNode = (0, xmlUtils_js_1.getElementsByTagName)(font, "color")[0];
                if (colorNode) {
                    const rgb = colorNode.getAttribute("rgb");
                    if (rgb)
                        formatting.color = '#' + rgb.substring(2); // Remove alpha channel
                }
                const nameNode = (0, xmlUtils_js_1.getElementsByTagName)(font, "name")[0];
                if (nameNode) {
                    const val = nameNode.getAttribute("val");
                    if (val)
                        formatting.font = val;
                }
                const vertAlignNode = (0, xmlUtils_js_1.getElementsByTagName)(font, "vertAlign")[0];
                if (vertAlignNode) {
                    const val = vertAlignNode.getAttribute("val");
                    if (val === "subscript")
                        formatting.subscript = true;
                    if (val === "superscript")
                        formatting.superscript = true;
                }
                fonts.push(formatting);
            }
        }
        // Parse fills (for background color)
        const fillsNode = (0, xmlUtils_js_1.getElementsByTagName)(xml, "fills")[0];
        const fills = [];
        if (fillsNode) {
            const fillNodes = (0, xmlUtils_js_1.getElementsByTagName)(fillsNode, "fill");
            for (const fill of fillNodes) {
                const formatting = {};
                const patternFill = (0, xmlUtils_js_1.getElementsByTagName)(fill, "patternFill")[0];
                if (patternFill) {
                    const fgColor = (0, xmlUtils_js_1.getElementsByTagName)(patternFill, "fgColor")[0];
                    if (fgColor) {
                        const rgb = fgColor.getAttribute("rgb");
                        const theme = fgColor.getAttribute("theme");
                        if (rgb && rgb !== "00000000") { // Not default/auto
                            formatting.backgroundColor = '#' + rgb.substring(2);
                        }
                        else if (theme) {
                            // Basic mapping for standard Office themes (Dark 1, Light 1, Dark 2, Light 2)
                            // 0: Light 1 (White), 1: Dark 1 (Black), 2: Light 2 (Tan/Gray), 3: Dark 2 (Blue/Grey)
                            const themeIdx = parseInt(theme);
                            if (themeIdx === 0)
                                formatting.backgroundColor = '#FFFFFF';
                            else if (themeIdx === 1)
                                formatting.backgroundColor = '#000000';
                            else if (themeIdx === 2)
                                formatting.backgroundColor = '#EEECE1'; // Standard Light 2
                            else if (themeIdx === 3)
                                formatting.backgroundColor = '#1F497D'; // Standard Dark 2
                        }
                    }
                }
                fills.push(formatting);
            }
        }
        // Parse cellXfs (cell format definitions)
        const cellXfsNode = (0, xmlUtils_js_1.getElementsByTagName)(xml, "cellXfs")[0];
        if (cellXfsNode) {
            const xfNodes = (0, xmlUtils_js_1.getElementsByTagName)(cellXfsNode, "xf");
            for (let i = 0; i < xfNodes.length; i++) {
                const xf = xfNodes[i];
                const formatting = {};
                const fontId = xf.getAttribute("fontId");
                if (fontId) {
                    const fontIdx = parseInt(fontId);
                    if (fonts[fontIdx]) {
                        Object.assign(formatting, fonts[fontIdx]);
                    }
                }
                const fillId = xf.getAttribute("fillId");
                if (fillId) {
                    const fillIdx = parseInt(fillId);
                    if (fills[fillIdx] && fills[fillIdx].backgroundColor) {
                        formatting.backgroundColor = fills[fillIdx].backgroundColor;
                    }
                }
                const alignmentNode = (0, xmlUtils_js_1.getElementsByTagName)(xf, "alignment")[0];
                if (alignmentNode) {
                    const horizontal = alignmentNode.getAttribute("horizontal");
                    if (horizontal === 'center' || horizontal === 'right' || horizontal === 'justify' || horizontal === 'left') {
                        formatting.alignment = horizontal;
                    }
                }
                cellFormatMap[i] = formatting;
            }
        }
    }
    const attachments = [];
    const mediaFiles = files.filter(f => f.path.match(/xl\/media\/.*/));
    const chartFiles = files.filter(f => f.path.match(chartsRegex));
    // Map to store image details by drawing file path and relationship ID
    const drawingImageMap = {};
    if (config.extractAttachments) {
        // 1. Parse Drawing Rels to map rIds to media paths
        const drawingRelsFiles = files.filter(f => f.path.match(drawingRelsRegex));
        for (const relFile of drawingRelsFiles) {
            const drawingFilename = relFile.path.split('/').pop()?.replace('.rels', '') || '';
            const drawingPath = `xl/drawings/${drawingFilename}`;
            const relsXml = (0, xmlUtils_js_1.parseXmlString)(relFile.content.toString());
            const relationships = (0, xmlUtils_js_1.getElementsByTagName)(relsXml, "Relationship");
            if (!drawingImageMap[drawingPath]) {
                drawingImageMap[drawingPath] = {};
            }
            for (const rel of relationships) {
                const id = rel.getAttribute("Id");
                const target = rel.getAttribute("Target");
                if (id && target && target.includes('media/')) {
                    // Target is usually like "../media/image1.png"
                    const mediaPath = 'xl/' + target.replace('../', '');
                    drawingImageMap[drawingPath][id] = { path: mediaPath };
                }
            }
        }
        // 2. Parse Drawings to get Alt Text and link to Rels
        const drawingFiles = files.filter(f => f.path.match(drawingsRegex));
        for (const drawingFile of drawingFiles) {
            const xml = (0, xmlUtils_js_1.parseXmlString)(drawingFile.content.toString());
            const pics = (0, xmlUtils_js_1.getElementsByTagName)(xml, "xdr:pic"); // SpreadsheetML drawing
            const rels = drawingImageMap[drawingFile.path] || {};
            for (const pic of pics) {
                const blipFill = (0, xmlUtils_js_1.getElementsByTagName)(pic, "xdr:blipFill")[0];
                const blip = blipFill ? (0, xmlUtils_js_1.getElementsByTagName)(blipFill, "a:blip")[0] : null;
                const embedId = blip ? blip.getAttribute("r:embed") : null;
                const nvPicPr = (0, xmlUtils_js_1.getElementsByTagName)(pic, "xdr:nvPicPr")[0];
                const cNvPr = nvPicPr ? (0, xmlUtils_js_1.getElementsByTagName)(nvPicPr, "xdr:cNvPr")[0] : null;
                const altText = cNvPr ? (cNvPr.getAttribute("descr") || cNvPr.getAttribute("name")) : undefined;
                if (embedId && rels[embedId]) {
                    rels[embedId].altText = altText || '';
                }
            }
        }
        // 3. Process Media Files
        for (const media of mediaFiles) {
            const attachment = (0, imageUtils_js_1.createAttachment)(media.path.split('/').pop() || 'image', media.content);
            // Try to find alt text for this media
            let altText = '';
            for (const drawingPath in drawingImageMap) {
                for (const rId in drawingImageMap[drawingPath]) {
                    if (drawingImageMap[drawingPath][rId].path === media.path) {
                        altText = drawingImageMap[drawingPath][rId].altText || '';
                        break;
                    }
                }
                if (altText)
                    break;
            }
            if (altText)
                attachment.altText = altText;
            attachments.push(attachment);
            if (config.ocr) {
                if (attachment.mimeType.startsWith('image/')) {
                    try {
                        const ocrText = (await (0, ocrUtils_js_1.performOcr)(media.content, { ...config.ocrConfig })).trim();
                        if (ocrText) {
                            attachment.ocrText = ocrText;
                        }
                    }
                    catch (e) {
                        (0, errorUtils_js_1.logWarning)(types_js_1.OfficeWarningType.OCR_FAILED, config, attachment.name, e);
                    }
                }
            }
        }
        for (const chart of chartFiles) {
            const attachment = {
                type: 'chart',
                mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                data: chart.content.toString('base64'),
                name: chart.path.split('/').pop() || '',
                extension: 'xml'
            };
            // Extract structured chart data
            try {
                const chartData = (0, chartUtils_js_1.extractChartData)(chart.content);
                attachment.chartData = chartData;
            }
            catch (e) {
                (0, errorUtils_js_1.logWarning)(types_js_1.OfficeWarningType.CHART_DATA_EXTRACTION_FAILED, config, chart.path, e);
            }
            attachments.push(attachment);
        }
    }
    // Build map of drawing rId -> chart attachment name for linking
    const drawingChartMap = {};
    if (config.extractAttachments) {
        const drawingRelsFiles = files.filter(f => f.path.match(drawingRelsRegex));
        for (const relFile of drawingRelsFiles) {
            const drawingFilename = relFile.path.split('/').pop()?.replace('.rels', '') || '';
            const drawingPath = `xl/drawings/${drawingFilename}`;
            const relsXml = (0, xmlUtils_js_1.parseXmlString)(relFile.content.toString());
            const relationships = (0, xmlUtils_js_1.getElementsByTagName)(relsXml, "Relationship");
            if (!drawingChartMap[drawingPath]) {
                drawingChartMap[drawingPath] = {};
            }
            for (const rel of relationships) {
                const id = rel.getAttribute("Id");
                const target = rel.getAttribute("Target");
                const type = rel.getAttribute("Type");
                if (id && target && type && type.includes('chart')) {
                    // Target is like "../charts/chart1.xml"
                    const chartName = target.split('/').pop() || '';
                    drawingChartMap[drawingPath][id] = chartName;
                }
            }
        }
    }
    // Parse workbook.xml to get sheet names and map them to sheet files
    const sheetNameMap = {};
    const workbookRelsFile = files.find(f => f.path === 'xl/_rels/workbook.xml.rels');
    if (workbookRelsFile) {
        // Parse rels to get rId -> file mapping
        const relsXml = (0, xmlUtils_js_1.parseXmlString)(workbookRelsFile.content.toString());
        const relationships = (0, xmlUtils_js_1.getElementsByTagName)(relsXml, "Relationship");
        const rIdToFile = {};
        for (const rel of relationships) {
            const rId = rel.getAttribute("Id");
            const target = rel.getAttribute("Target");
            if (rId && target) {
                // Target is like "worksheets/sheet1.xml"
                const filename = target.split('/').pop() || '';
                rIdToFile[rId] = filename;
            }
        }
        // Parse workbook.xml to get sheet name -> rId mapping
        const workbookXml = (0, xmlUtils_js_1.parseXmlString)(workbookFile.content.toString());
        const sheets = (0, xmlUtils_js_1.getElementsByTagName)(workbookXml, "sheet");
        for (const sheet of sheets) {
            (0, errorUtils_js_1.checkAbortSignal)(config.abortSignal);
            const name = sheet.getAttribute("name");
            const rId = sheet.getAttribute("r:id");
            if (name && rId && rIdToFile[rId]) {
                sheetNameMap[rIdToFile[rId]] = name;
            }
        }
    }
    const content = [];
    for (const file of files) {
        if (file.path.match(mediaFileRegex))
            continue;
        if (file.path === stringsFilePath)
            continue;
        if (file.path === 'xl/styles.xml')
            continue;
        if (file.path.match(drawingsRegex))
            continue;
        if (file.path.match(chartsRegex))
            continue;
        if (file.path.match(relsRegex))
            continue;
        if (file.path.match(drawingRelsRegex))
            continue;
        if (file.path.match(sheetsRegex)) {
            const sheetFilename = file.path.split('/').pop() || '';
            const relsFilename = `xl/worksheets/_rels/${sheetFilename}.rels`;
            const relsFile = files.find(f => f.path === relsFilename);
            const drawingMap = {}; // rId -> drawingPath
            const sheetCommentsMap = {};
            if (relsFile) {
                const relsXml = (0, xmlUtils_js_1.parseXmlString)(relsFile.content.toString());
                const relationships = (0, xmlUtils_js_1.getElementsByTagName)(relsXml, "Relationship");
                for (const rel of relationships) {
                    const id = rel.getAttribute("Id");
                    const target = rel.getAttribute("Target");
                    const type = rel.getAttribute("Type");
                    if (id && target && type) {
                        if (config.extractAttachments && type.includes('drawing')) {
                            drawingMap[id] = 'xl/drawings/' + target.replace('../drawings/', '');
                        }
                        else if (!config.ignoreComments && type.includes('comments')) {
                            const commentsPath = 'xl/' + target.replace('../', '');
                            const cFile = files.find(f => f.path === commentsPath);
                            if (cFile) {
                                const cXml = (0, xmlUtils_js_1.parseXmlString)(cFile.content.toString());
                                const commentNodes = (0, xmlUtils_js_1.getElementsByTagName)(cXml, "comment");
                                const authorsList = (0, xmlUtils_js_1.getElementsByTagName)(cXml, "author");
                                const authors = authorsList.map(a => a.textContent || '');
                                for (const cNode of commentNodes) {
                                    const ref = cNode.getAttribute("ref");
                                    const authorId = cNode.getAttribute("authorId");
                                    const author = authorId !== null ? authors[parseInt(authorId)] : undefined;
                                    const tNodes = (0, xmlUtils_js_1.getElementsByTagName)(cNode, "t");
                                    const text = tNodes.map(t => t.textContent || '').join('');
                                    if (ref && text) {
                                        if (!sheetCommentsMap[ref])
                                            sheetCommentsMap[ref] = [];
                                        sheetCommentsMap[ref].push({
                                            type: 'comment',
                                            text: text,
                                            children: [{ type: 'text', text: text, formatting: {} }],
                                            metadata: author ? { author } : undefined
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            const rows = [];
            const sheetXml = file.content.toString();
            // regex to match <row> elements, capturing:
            // 1. attributes (e.g., r="1")
            // 2. whether it's self-closing (/>)
            // 3. inner content (for non-self-closing rows)
            const rowRegex = /<row\b([^>]*?)(?:(\/>)|(>([\s\S]*?)<\/row>))/g;
            // matchAll provides an iterator over all matches, which is much more efficient than 
            // iterating over a massive sparse row range declared in spreadsheet dimensions.
            const rowMatches = sheetXml.matchAll(rowRegex);
            /** Helper to convert Excel column string (A, B, AA, etc.) to 0-based index */
            const colToNumber = (col) => {
                let num = 0;
                for (let i = 0; i < col.length; i++) {
                    num = num * 26 + (col.charCodeAt(i) - 'A'.charCodeAt(0) + 1);
                }
                return num - 1;
            };
            let lastRowIndex = -1;
            for (const rowMatch of rowMatches) {
                (0, errorUtils_js_1.checkAbortSignal)(config.abortSignal);
                const rowXml = rowMatch[0];
                const rowAttrs = rowMatch[1];
                const isSelfClosing = !!rowMatch[2];
                const rowContent = rowMatch[4] || "";
                if (!isSelfClosing && !rowContent.includes('<c'))
                    continue;
                const cells = [];
                // regex to match <c> (cell) elements within a row, capturing:
                // 1. cell attributes (e.g., r="A1", t="s")
                // 2. whether it's self-closing (/>)
                // 3. inner content (e.g., <v> value)
                const cRegex = /<c\b([^>]*?)(?:(\/>)|(>([\s\S]*?)<\/c>))/g;
                const cMatches = rowContent.matchAll(cRegex);
                const rMatch = rowAttrs.match(/r="(\d+)"/);
                const rowIndex = rMatch ? parseInt(rMatch[1]) - 1 : lastRowIndex + 1;
                lastRowIndex = rowIndex;
                let lastColIndex = -1;
                for (const cMatch of cMatches) {
                    const cXml = cMatch[0];
                    const cAttrs = cMatch[1];
                    const cContent = cMatch[4] || "";
                    // Extract cell value
                    const typeMatch = cAttrs.match(/t="([a-zA-Z]+)"/);
                    const type = typeMatch ? typeMatch[1] : 'n'; // n = number (default)
                    const vMatch = cContent.match(/<v>([\s\S]*?)<\/v>/);
                    const tMatch = cContent.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
                    let text = '';
                    let cellNodes = [];
                    if (type === 's' && vMatch) {
                        const idx = parseInt(vMatch[1]);
                        const content = sharedStrings[idx];
                        if (Array.isArray(content)) {
                            // Rich text runs
                            // Deep copy runs to avoid reference issues if reused
                            cellNodes = JSON.parse(JSON.stringify(content));
                            text = cellNodes.map(n => n.text).join('');
                        }
                        else {
                            text = content || '';
                        }
                    }
                    else if (type === 'inlineStr' && tMatch) {
                        text = (0, xmlUtils_js_1.decodeXmlEntities)(tMatch[1].trim());
                    }
                    else if (vMatch) {
                        text = vMatch[1].trim();
                    }
                    // Parse cell coordinate
                    const coordMatch = cAttrs.match(/r="([A-Z]+)(\d+)"/);
                    let colIndex;
                    let ref;
                    if (coordMatch) {
                        ref = coordMatch[1] + coordMatch[2];
                        colIndex = colToNumber(coordMatch[1]);
                        // If row index is missing in cell coord (unlikely but possible), use rowIndex
                    }
                    else {
                        colIndex = lastColIndex + 1;
                    }
                    lastColIndex = colIndex;
                    if (text || cellNodes.length > 0) {
                        // Extract cell style index
                        const styleMatch = cAttrs.match(/s="(\d+)"/);
                        const styleIdx = styleMatch ? parseInt(styleMatch[1]) : undefined;
                        const cellFormatting = (styleIdx !== undefined && cellFormatMap[styleIdx]) ? cellFormatMap[styleIdx] : {};
                        if (cellNodes.length > 0) {
                            // If we have specific runs, merge cell styles into them if run style is missing
                            // But usually run style overrides cell style (except maybe background)
                            for (const node of cellNodes) {
                                if (!node.formatting)
                                    node.formatting = {};
                                // Cell background always applies
                                if (cellFormatting.backgroundColor)
                                    node.formatting.backgroundColor = cellFormatting.backgroundColor;
                                // Cell alignment always applies
                                if (cellFormatting.alignment)
                                    node.formatting.alignment = cellFormatting.alignment;
                                // Font defaults from cell style if not in run
                                if (!node.formatting.font && cellFormatting.font)
                                    node.formatting.font = cellFormatting.font;
                                if (!node.formatting.size && cellFormatting.size)
                                    node.formatting.size = cellFormatting.size;
                            }
                        }
                        else {
                            // Simple text node
                            cellNodes.push({
                                type: 'text',
                                text: text,
                                formatting: cellFormatting
                            });
                        }
                        const commentsNodeList = (ref && sheetCommentsMap[ref]) ? sheetCommentsMap[ref] : undefined;
                        const cellNode = {
                            type: 'cell',
                            text: text,
                            children: cellNodes,
                            comments: commentsNodeList,
                            metadata: { row: rowIndex, col: colIndex }
                        };
                        if (config.includeRawContent) {
                            cellNode.rawContent = cXml;
                        }
                        cells.push(cellNode);
                    }
                }
                if (cells.length > 0) {
                    const rowNode = {
                        type: 'row',
                        children: cells,
                        metadata: undefined
                    };
                    if (config.includeRawContent) {
                        rowNode.rawContent = rowXml;
                    }
                    rows.push(rowNode);
                }
            }
            // Handle Drawings in Sheet (images and charts)
            if (config.extractAttachments) {
                const drawingMatches = file.content.toString().match(/<drawing r:id="(.*?)"/g);
                if (drawingMatches) {
                    for (const match of drawingMatches) {
                        const rIdMatch = match.match(/r:id="(.*?)"/);
                        const rId = rIdMatch ? rIdMatch[1] : null;
                        if (rId && drawingMap[rId]) {
                            const drawingPath = drawingMap[rId];
                            // Find all images in this drawing
                            const images = drawingImageMap[drawingPath];
                            if (images) {
                                for (const imgId in images) {
                                    const imgInfo = images[imgId];
                                    const attachment = attachments.find(a => a.name === imgInfo.path.split('/').pop());
                                    if (attachment) {
                                        const imageNode = {
                                            type: 'image',
                                            text: '', // Will be populated by assignAttachmentData
                                            children: [],
                                            metadata: {
                                                attachmentName: attachment.name || 'unknown',
                                                altText: imgInfo.altText || undefined
                                            }
                                        };
                                        rows.push(imageNode);
                                    }
                                }
                            }
                            // Find all charts in this drawing
                            const charts = drawingChartMap[drawingPath];
                            if (charts) {
                                for (const chartRId in charts) {
                                    const chartName = charts[chartRId];
                                    const attachment = attachments.find(a => a.name === chartName);
                                    if (attachment) {
                                        const chartNode = {
                                            type: 'chart',
                                            text: '', // Will be populated by assignAttachmentData
                                            children: [],
                                            metadata: {
                                                attachmentName: chartName
                                            }
                                        };
                                        rows.push(chartNode);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // Get proper sheet name from workbook.xml mapping, fallback to filename
            const sheetFileName = file.path.split('/').pop() || 'Sheet';
            const sheetName = sheetNameMap[sheetFileName] || sheetFileName;
            content.push({
                type: 'sheet',
                children: rows,
                metadata: { sheetName },
                rawContent: config.includeRawContent ? file.content.toString() : undefined
            });
        }
    }
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
        if (Object.keys(appProperties).length > 0)
            metadata.nativeProperties = appProperties;
    }
    // Link OCR text and chart data to content nodes (like PPTX parser)
    const assignAttachmentData = (nodes) => {
        for (const node of nodes) {
            if ('attachmentName' in (node.metadata || {})) {
                const meta = node.metadata;
                const attachment = attachments.find(a => a.name === meta.attachmentName);
                if (attachment) {
                    if (node.type === 'image') {
                        // Link OCR text to image node
                        if (attachment.ocrText) {
                            node.text = attachment.ocrText;
                        }
                        // Copy altText to attachment
                        if (meta.altText) {
                            attachment.altText = meta.altText;
                        }
                    }
                    if (node.type === 'chart') {
                        // Link chart data text to chart node
                        if (attachment.chartData) {
                            node.text = attachment.chartData.rawTexts.join(config.newlineDelimiter);
                        }
                    }
                }
            }
            if (node.children) {
                assignAttachmentData(node.children);
            }
        }
    };
    assignAttachmentData(content);
    const toTextSync = () => content.map(c => {
        // Recursive text extraction
        const getText = (node) => {
            let t = '';
            if (node.children) {
                t += node.children.map(getText).filter(t => t != '').join(!node.children[0]?.children ? '' : config.newlineDelimiter);
            }
            else
                t += node.text || '';
            return t;
        };
        return getText(c);
    }).filter(t => t != '').join(config.newlineDelimiter);
    return (0, astUtils_js_1.createAST)('xlsx', metadata, content, attachments, config, undefined, toTextSync);
};
exports.parseExcel = parseExcel;
