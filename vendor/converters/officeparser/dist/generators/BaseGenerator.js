"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseGenerator = void 0;
const types_js_1 = require("../types.js");
const configUtils_js_1 = require("../utils/configUtils.js");
const errorUtils_js_1 = require("../utils/errorUtils.js");
const styleMapper_js_1 = require("../utils/styleMapper.js");
/**
 * Base class for all document generators.
 * Provides common traversal logic and configuration handling.
 */
class BaseGenerator {
    destination;
    config;
    ast;
    messages = [];
    styleMapper;
    collectedNotes = [];
    constructor(destination, ast, config) {
        this.destination = destination;
        this.config = (0, configUtils_js_1.resolveGeneratorConfig)(destination, ast.config, config);
        this.ast = ast;
        this.styleMapper = new styleMapper_js_1.StyleMapper(this.config.styleMap, this.config.ignoreDefaultStyleMap);
    }
    /**
     * The document metadata a generator should write out: `ast.metadata` with
     * `config.metadataOverrides` applied on top, per field.
     *
     * Every generator must read metadata through here rather than touching `this.ast.metadata`
     * directly, so an override reaches all of them uniformly instead of one format at a time.
     *
     * Merged rather than replaced, so overriding one field doesn't blank the rest, and computed
     * fresh rather than cached on the AST: overrides are an output concern, and mutating
     * `ast.metadata` would leak one generation's settings into the next use of the same AST.
     * `custom` merges into `customProperties` so callers see one bucket regardless of origin.
     */
    get effectiveMetadata() {
        const base = this.ast.metadata || {};
        const overrides = this.config.metadataOverrides;
        if (!overrides)
            return base;
        const { custom, language, ...named } = overrides;
        const merged = { ...base };
        // Assign only the fields actually supplied - spreading `named` wholesale would write
        // `undefined` over parsed values for every field the caller left out.
        for (const [key, value] of Object.entries(named)) {
            if (value !== undefined)
                merged[key] = value;
        }
        // `language` has no slot on OfficeMetadata; parsers already surface it through
        // nativeProperties, so an override belongs in the same place rather than widening the
        // parser-side type for a generator concern. Generators reading `nativeProperties.language`
        // then pick it up with no change.
        if (language !== undefined) {
            merged.nativeProperties = { ...(base.nativeProperties || {}), language };
        }
        if (custom && Object.keys(custom).length > 0) {
            merged.customProperties = { ...(base.customProperties || {}), ...custom };
        }
        return merged;
    }
    /**
     * Reports caller-supplied `metadataOverrides.custom` entries that the destination format has
     * no way to represent (EPUB's OPF and RTF's `\info` both have fixed vocabularies).
     *
     * Warning rather than dropping silently: a caller who sets metadata and never sees it in the
     * output otherwise has no way to find out. Only `custom` keys are reported - the named fields
     * map onto something in every format that carries metadata at all.
     */
    warnUnrepresentableCustomMetadata(format) {
        const custom = this.config.metadataOverrides?.custom;
        if (!custom)
            return;
        const keys = Object.keys(custom);
        if (keys.length === 0)
            return;
        this.warn(types_js_1.OfficeWarningType.METADATA_NOT_REPRESENTABLE, { keys, format });
    }
    /**
     * Retrieves the semantic mapping for a node, respecting the includeFormatting flag.
     * Per design requirements: Style mapping is bypassed if formatting is disabled.
     */
    getSemanticMapping(node) {
        if (this.config.includeFormatting === false) {
            return undefined;
        }
        return this.styleMapper.getMapping(node);
    }
    /**
     * Centralized logic for handling the onNode callback.
     * Evaluates the callback and returns a result that tells the generator how to proceed.
     *
     * @returns
     * - `string`: Use this as the node's output, skip default processing.
     * - `false`: Skip this node and its subtree.
     * - `void`: Proceed with default processing.
     */
    async handleOnNode(node) {
        const result = await this.config.onNode(node);
        if (result === false)
            return false;
        if (typeof result === 'string')
            return result;
    }
    /**
     * Recursively processes nodes and builds output.
     *
     * @param node - The current node being processed
     * @param processor - A function that takes a node and its children's output and returns the node's output string.
     * @returns The generated string for this node and its subtree.
     */
    async processNodeRecursive(node, processor) {
        // Every text-based generator funnels its whole traversal through here, so one check
        // makes `abortSignal` effective for all of them. Previously the signal was read once
        // before generation began and never again, which meant it could decline to start work
        // but could not stop work already underway - not much use against a document large
        // enough to be worth aborting. The check is a property read on an optional signal, so
        // the per-node cost is negligible.
        (0, errorUtils_js_1.checkAbortSignal)(this.config.abortSignal);
        const override = await this.handleOnNode(node);
        if (override === false)
            return '';
        if (typeof override === 'string')
            return override;
        let childrenOutput = '';
        if (node.children) {
            for (const child of node.children) {
                childrenOutput += await this.processNodeRecursive(child, processor);
            }
        }
        if (node.notes && node.notes.length > 0) {
            if (node.type !== 'slide') {
                this.collectedNotes.push(...node.notes);
            }
        }
        let result = await processor(node, childrenOutput);
        if (node.type === 'slide' && node.notes && node.notes.length > 0) {
            for (const note of node.notes) {
                result += await this.processNodeRecursive(note, processor);
            }
        }
        return result;
    }
    /**
     * Helper to generate a unique ID (slug) from text.
     */
    slugify(text) {
        return text
            .toLowerCase()
            .replace(/[^\w\s-]/g, '')
            .replace(/[\s_-]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }
    noteFootnoteKeys = new Map();
    usedFootnoteKeys = new Set();
    footnoteKeyCounter = 0;
    /**
     * Assigns a stable, unique reference key to a footnote/endnote node, reused for both
     * its inline reference marker and its collected definition. Source ids aren't reliably
     * unique across a document - DOCX/ODT number footnotes and endnotes in separate
     * sequences, so both can carry noteId "1" - so a source id is only reused when it
     * hasn't already been claimed; otherwise a sequential counter guarantees uniqueness.
     */
    getFootnoteKey(note) {
        const cached = this.noteFootnoteKeys.get(note);
        if (cached)
            return cached;
        const preferred = note.metadata?.noteId;
        // The id is document-supplied and lands inside `[^...]` in Markdown, where the parser's
        // own recognizer accepts everything but `]` - so a note id carrying markup round-tripped
        // into the output verbatim. Accept it only when it looks like a label; otherwise fall
        // through to the sequential counter, which is always safe. Real ids are numeric (DOCX),
        // `ftn1`-shaped (ODT) or short slugs (`fn1`), and a Markdown label like `[^my note]`
        // still qualifies, so the fallback fires only for genuinely hostile input.
        const isLabelLike = typeof preferred === 'string' && /^[A-Za-z0-9_.:-][A-Za-z0-9 _.:-]*$/.test(preferred);
        let key;
        if (preferred && isLabelLike && !this.usedFootnoteKeys.has(preferred)) {
            key = preferred;
        }
        else {
            do {
                this.footnoteKeyCounter++;
                key = String(this.footnoteKeyCounter);
            } while (this.usedFootnoteKeys.has(key));
        }
        this.usedFootnoteKeys.add(key);
        this.noteFootnoteKeys.set(note, key);
        return key;
    }
    /**
     * True when every content-bearing text descendant satisfies `test` - i.e. the property is
     * uniform across the whole node and therefore says nothing the node type does not already say.
     *
     * Used to decide whether a heading's or header row's inherited formatting can be dropped. The
     * distinction matters: an ODF heading whose paragraph style is bold and 14pt yields a heading
     * where *every* run is bold and 14pt, and re-emitting that gives `# **Heading**` in Markdown
     * and, worse in RTF/HTML, an inner font-size that overrides the heading's own and visibly
     * shrinks it. But `# Normal **Bold** Normal` is an author contrasting one word against the
     * rest, and dropping that would discard real meaning. Only the uniform case is safe.
     *
     * Returns false when there is no text to judge, so an empty or image-only node never triggers
     * suppression.
     */
    hasUniformFormatting(node, test) {
        let sawText = false;
        const walk = (n) => {
            if (n.type === 'text') {
                // Whitespace-only runs carry no visible formatting either way, so they neither
                // count as evidence nor veto - otherwise a stray unformatted space between two
                // bold runs would defeat the check on almost every real heading.
                if (!(n.text || '').trim())
                    return true;
                sawText = true;
                return test(n.formatting);
            }
            return (n.children ?? []).every(walk);
        };
        const uniform = (node.children ?? []).every(walk);
        return sawText && uniform;
    }
    /**
     * Recursively extracts plain text from a node and its children.
     */
    getNodeText(node) {
        if (node.text)
            return node.text;
        if (node.children) {
            return node.children.map(c => this.getNodeText(c)).join('');
        }
        return '';
    }
    /**
     * Reports a warning to the user and collects it for the final result.
     */
    warn(type, info, node) {
        const message = (0, errorUtils_js_1.getWarningMessage)(type, info);
        const issue = {
            type: 'warning',
            code: type,
            message,
            node,
            details: info
        };
        this.messages.push(issue);
        this.config.onWarning(issue);
    }
}
exports.BaseGenerator = BaseGenerator;
