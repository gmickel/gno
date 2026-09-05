import { ConversionResult, GeneratorConfig, OfficeParserAST } from '../types.js';
import { BaseGenerator } from './BaseGenerator.js';
/**
 * Generates a minimal, valid EPUB 3 file from an AST.
 *
 * Every AST node is rendered as a single XHTML content document (reusing `HtmlGenerator`
 * for the actual markup, since EPUB content documents are XHTML) and packaged with the
 * required `mimetype`, `META-INF/container.xml`, OPF manifest, and navigation document.
 *
 * `HtmlGenerator` embeds images as base64 `data:` URIs, but EPUB reading systems do not
 * render `data:` URIs - images must be packaged as separate resources referenced by a
 * relative path. So each data-URI image is extracted into `OEBPS/images/`, declared in
 * the manifest, and its `<img src>` rewritten to point at the packaged file.
 */
export declare class EpubGenerator extends BaseGenerator<'epub'> {
    constructor(ast: OfficeParserAST, config?: GeneratorConfig<'epub'>);
    /**
     * Resolves the modification instant used for both the EPUB 3 `dcterms:modified` property
     * (which the specification requires) and every zip entry's mtime.
     *
     * Takes the value from `effectiveMetadata`, i.e. `metadataOverrides.modified` if the caller
     * set one, otherwise the source document's own `metadata.modified`, and only falls back to
     * the current time when neither exists. That last fallback is the sole non-reproducible
     * option, so it is the last resort rather than the default.
     *
     * **Both outputs matter for reproducibility.** `dcterms:modified` is the visible one, but
     * `zipSync` defaults each entry's mtime to `Date.now()`, so pinning only the OPF still
     * yields archives that differ byte-for-byte on every run. That second source is easy to
     * miss because DOS zip timestamps have two-second granularity - back-to-back generation
     * looks stable and only a gap longer than that reveals it.
     *
     * `iso` is `YYYY-MM-DDThh:mm:ssZ` (UTC, whole seconds) as EPUB requires; `toISOString()`
     * emits milliseconds, so they are stripped.
     */
    private resolveModified;
    /**
     * Zip's DOS timestamp field cannot represent dates outside 1980-2099, and fflate throws
     * rather than clamping. A document legitimately carrying a date outside that window (an
     * unset/epoch-zero mtime is the common case) must not take EPUB generation down with it.
     */
    private clampToZipRange;
    generate(): Promise<ConversionResult<'epub'>>;
}
