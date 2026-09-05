"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StyleMapper = void 0;
const types_js_1 = require("../types.js");
const errorUtils_js_1 = require("./errorUtils.js");
const DEFAULT_MAPPINGS = [
    { selector: { nodeType: 'paragraph', attributes: { 'style-name': 'Heading 1' } }, output: { tag: 'h1' } },
    { selector: { nodeType: 'paragraph', attributes: { 'style-name': 'Heading 2' } }, output: { tag: 'h2' } },
    { selector: { nodeType: 'paragraph', attributes: { 'style-name': 'Heading 3' } }, output: { tag: 'h3' } },
    { selector: { nodeType: 'paragraph', attributes: { 'style-name': 'Heading 4' } }, output: { tag: 'h4' } },
    { selector: { nodeType: 'paragraph', attributes: { 'style-name': 'Heading 5' } }, output: { tag: 'h5' } },
    { selector: { nodeType: 'paragraph', attributes: { 'style-name': 'Heading 6' } }, output: { tag: 'h6' } },
    { selector: { nodeType: 'paragraph', attributes: { 'style-name': 'Title' } }, output: { tag: 'h1', classes: ['title'] } },
    { selector: { nodeType: 'paragraph', attributes: { 'style-name': 'Subtitle' } }, output: { tag: 'p', classes: ['subtitle'] } },
    { selector: { nodeType: 'paragraph', attributes: { 'style-name': 'Quote' } }, output: { tag: 'blockquote' } },
    { selector: { nodeType: 'paragraph', attributes: { 'style-name': 'Intense Quote' } }, output: { tag: 'blockquote', classes: ['intense'] } },
];
/**
 * Parser and matcher for the style mapping DSL.
 * Supports a structured JSON format and a legacy string DSL.
 */
class StyleMapper {
    mappings = [];
    constructor(mappings, ignoreDefaults = false) {
        // 1. Add user mappings (they take precedence)
        if (mappings) {
            if (Array.isArray(mappings)) {
                for (const m of mappings) {
                    if (typeof m === 'string') {
                        this.mappings.push(this.parseMappingString(m));
                    }
                    else {
                        this.mappings.push(this.convertStructuredMapping(m));
                    }
                }
            }
            else {
                // Support legacy object format: { 'Heading 1': { tag: 'h1', class: 'title' } }
                for (const [styleName, target] of Object.entries(mappings)) {
                    this.mappings.push({
                        selector: {
                            attributes: { style: { value: styleName, operator: '=' } }
                        },
                        output: {
                            tag: target.tag || 'div',
                            classes: target.class ? target.class.split(' ') : [],
                            attributes: {},
                            fresh: false
                        }
                    });
                }
            }
        }
        // 2. Add default mappings if not ignored
        if (!ignoreDefaults) {
            this.mappings.push(...DEFAULT_MAPPINGS.map(m => this.convertStructuredMapping(m)));
        }
    }
    /**
     * Finds the best matching mapping for a node.
     */
    getMapping(node) {
        for (const mapping of this.mappings) {
            if (this.matches(node, mapping.selector)) {
                return mapping.output;
            }
        }
        return undefined;
    }
    matches(node, selector) {
        // Match node type if specified
        if (selector.nodeType && node.type !== selector.nodeType) {
            return false;
        }
        // Match attributes (style, level, etc.)
        for (const [attr, { value, operator, compiled }] of Object.entries(selector.attributes)) {
            const actualValue = this.getNodeAttribute(node, attr);
            if (actualValue === undefined)
                return false;
            if (operator === '=') {
                if (String(actualValue) !== String(value))
                    return false;
            }
            else if (operator === '~=') {
                const regex = compiled || new RegExp(String(value));
                if (!regex.test(String(actualValue)))
                    return false;
            }
        }
        return true;
    }
    getNodeAttribute(node, attr) {
        // Special case for style (alias style-name for mammoth.js compatibility)
        if (attr === 'style' || attr === 'style-name') {
            return node.metadata?.style || node.formatting?.font;
        }
        // Metadata attributes
        if (node.metadata && attr in node.metadata) {
            return node.metadata[attr];
        }
        // Formatting attributes
        if (node.formatting && attr in node.formatting) {
            return node.formatting[attr];
        }
        return undefined;
    }
    convertStructuredMapping(m) {
        const attributes = {};
        if (m.selector.attributes) {
            for (const [key, val] of Object.entries(m.selector.attributes)) {
                if (typeof val === 'object' && val !== null && 'value' in val) {
                    const operator = val.operator || '=';
                    attributes[key] = {
                        value: val.value,
                        operator,
                        compiled: operator === '~=' ? new RegExp(String(val.value)) : undefined
                    };
                }
                else {
                    attributes[key] = {
                        value: val,
                        operator: '='
                    };
                }
            }
        }
        return {
            selector: {
                nodeType: m.selector.nodeType,
                attributes
            },
            output: {
                tag: m.output.tag,
                classes: m.output.classes || [],
                attributes: m.output.attributes || {},
                fresh: m.output.fresh || false
            }
        };
    }
    /**
     * Parses a mapping string like "p[style-name='Heading 1'] => h1.title:fresh"
     */
    parseMappingString(mapping) {
        const lastIndex = mapping.lastIndexOf('=>');
        if (lastIndex === -1) {
            throw (0, errorUtils_js_1.getOfficeError)(types_js_1.OfficeErrorType.INVALID_STYLE_MAPPING, undefined, mapping);
        }
        const selectorStr = mapping.substring(0, lastIndex).trim();
        const outputStr = mapping.substring(lastIndex + 2).trim();
        // Parse Selector
        const selectorMatch = selectorStr.match(/^([a-z]+)?(?:\[(.+?)\])?$/);
        if (!selectorMatch) {
            throw (0, errorUtils_js_1.getOfficeError)(types_js_1.OfficeErrorType.INVALID_SELECTOR, undefined, selectorStr);
        }
        const typeMap = {
            'p': 'paragraph',
            'h': 'heading',
            't': 'table',
            'tr': 'row',
            'td': 'cell',
            'li': 'list',
            'img': 'image'
        };
        const nodeType = selectorMatch[1] ? (typeMap[selectorMatch[1]] || selectorMatch[1]) : undefined;
        const attrStr = selectorMatch[2];
        const attributes = {};
        if (attrStr) {
            // Improved attribute parsing to handle commas inside quotes
            const attrParts = [];
            let currentPart = '';
            let inQuotes = false;
            for (let i = 0; i < attrStr.length; i++) {
                const char = attrStr[i];
                if (char === "'" || char === '"')
                    inQuotes = !inQuotes;
                if (char === ',' && !inQuotes) {
                    attrParts.push(currentPart.trim());
                    currentPart = '';
                }
                else {
                    currentPart += char;
                }
            }
            if (currentPart)
                attrParts.push(currentPart.trim());
            for (const part of attrParts) {
                const m = part.match(/^([\w-]+)\s*(=|~=)\s*(?:(["'])(.*?)\3|(.+))$/);
                if (m) {
                    const operator = m[2];
                    const value = m[4] !== undefined ? m[4] : m[5];
                    attributes[m[1]] = {
                        operator,
                        value,
                        compiled: operator === '~=' ? new RegExp(value) : undefined
                    };
                }
            }
        }
        // Parse Output
        const outputParts = outputStr.split(':');
        const fresh = outputParts.includes('fresh');
        const mainOutput = outputParts[0];
        const outputMatch = mainOutput.match(/^([a-z0-9]+)?((?:\.[\w-]+)*)(?:\[(.+?)\])?$/);
        if (!outputMatch) {
            throw (0, errorUtils_js_1.getOfficeError)(types_js_1.OfficeErrorType.INVALID_OUTPUT_MAPPING, undefined, mainOutput);
        }
        const tag = outputMatch[1] || 'div';
        const classes = outputMatch[2] ? outputMatch[2].split('.').filter(Boolean) : [];
        const outAttrs = {};
        if (outputMatch[3]) {
            const outAttrParts = outputMatch[3].split(',').map(a => a.trim());
            for (const part of outAttrParts) {
                const m = part.match(/^([\w-]+)\s*=\s*(?:(["'])(.*?)\2|(.+))$/);
                if (m)
                    outAttrs[m[1]] = m[3] !== undefined ? m[3] : m[4];
            }
        }
        return {
            selector: { nodeType, attributes },
            output: { tag, classes, attributes: outAttrs, fresh }
        };
    }
}
exports.StyleMapper = StyleMapper;
