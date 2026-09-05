/**
 * Shared output-sanitization helpers.
 *
 * Every string in the parsed AST originates from an untrusted document, so any
 * value interpolated into generated output (HTML, XHTML, CSS, URLs, inline
 * scripts, CSV, RTF, Markdown) must be escaped for its destination context.
 * These are the single source of truth — each generator delegates to them so
 * escaping stays consistent and a gap fixed here is fixed everywhere.
 */
/**
 * Whether a string is a plain HTML attribute *name*, safe to interpolate before `="..."`.
 *
 * Escaping the value is not enough on its own: a key containing a quote or `=` closes the
 * attribute and opens another, so `x" onmouseover="alert(1)" z` yields a real event handler no
 * matter how carefully the value is escaped. This is the shape an attribute-injection payload
 * takes, and rejecting it outright is simpler and safer than trying to escape a name.
 *
 * The predicate is shared rather than restated because it is now applied at four independent
 * points (the parser's attribute collection, the generator's attribute bag, and two
 * styleMap-driven paths). Each of those still keeps its own skip-list inline: the lists are the
 * same policy expressed for different layers, and collapsing them would erase the defence in
 * depth the surrounding comments describe.
 */
export declare function isSafeHtmlAttributeName(name: string): boolean;
/**
 * Whether a `styleMap` `output.tag` may be emitted as an element name.
 *
 * Callers must fall back to their default tag when this returns false, never emit the value.
 */
export declare function isSafeStyleMapTag(tag: unknown): tag is string;
/**
 * Escapes text for an HTML text node or a double-quoted attribute value.
 * Includes the single quote so the result is also safe inside single-quoted
 * attributes.
 */
export declare function escapeHtml(text: string): string;
/**
 * Escapes text for an XML text node or attribute (XHTML/OPF/NCX). Same as
 * escapeHtml but emits the XML-canonical `&apos;` for the single quote.
 */
export declare function escapeXml(text: string): string;
/**
 * Sanitizes a single CSS value (e.g. a color/size/font/alignment pulled from a
 * document) for placement inside a `style="prop: VALUE"` attribute.
 *
 * - Drops the whole value if it contains a resource-fetching or executing
 *   construct (`url()`, `expression()`, `@import`, `image-set()`, `javascript:`)
 *   or angle brackets that could break out of the attribute/tag.
 * - Strips characters that break out of `prop: value` (`;`, quotes), out of a
 *   `<style>` rule (`{}`), CSS escapes (`\`), and control characters.
 *
 * `rgb()/hsl()` and hex/named colors, lengths, and (unquoted) font names all
 * survive; the trade-off is that legitimately quoted font names lose their
 * quotes, which browsers tolerate.
 */
export declare function sanitizeCssValue(value: string): string;
/**
 * Escapes a document-supplied URL for use in an href/src attribute. Beyond the
 * usual attribute escaping, this rejects script-executing schemes (javascript:,
 * vbscript:, data:, etc.) so a hyperlink extracted from an untrusted document
 * can't run code when clicked — only http(s)/mailto/tel and relative/fragment
 * URLs are passed through.
 */
export declare function sanitizeUrl(url: string): string;
/**
 * Decide whether a non-provider `<iframe>` should be preserved, per
 * `HtmlParserConfig.preserveIframes`. `true` allows any src; an array is a hostname allowlist,
 * where an entry matches the src's host exactly or as a `.`-suffix (so `"vimeo.com"` also matches
 * `player.vimeo.com`). A relative or unparseable src is allowed only under `true`. This is a
 * preservation gate, not a sanitizer - the src is still scheme-checked with `sanitizeUrl` on
 * generation.
 */
export declare function iframeAllowed(src: string, preserve: boolean | string[] | undefined): boolean;
/**
 * Like sanitizeUrl but for an <img>/<source> src: additionally permits
 * `data:image/*` URIs (embedded document images) while still rejecting
 * script-executing schemes and non-image data URIs (e.g. data:text/html).
 */
export declare function sanitizeImageUrl(url: string): string;
/**
 * Serializes data for embedding inside an inline <script> block. JSON.stringify
 * alone doesn't escape "<", so a value containing "</script>" (e.g. a chart
 * label from attacker-controlled document XML) would close the script early and
 * inject markup. Also escapes the U+2028/U+2029 line separators, which are
 * invalid in JS string literals.
 */
export declare function serializeForInlineScript(data: unknown): string;
/**
 * Formats a value for a CSV field: guards against spreadsheet formula/DDE
 * injection (CWE-1236) and applies RFC 4180 quoting.
 *
 * A cell beginning with `= + - @` (or a tab/CR that some apps treat as a
 * formula start) is prefixed with a single quote so Excel/Sheets render it as
 * literal text rather than executing it. Genuine numbers (including negatives)
 * are exempt so numeric columns are preserved.
 */
export declare function csvSafeCell(value: string, delimiter: string): string;
/**
 * Validates and escapes a document-supplied URL for an RTF `HYPERLINK` field argument.
 *
 * Mirrors `sanitizeUrl`'s contract (validate the scheme, then encode for the destination, else
 * return `''`) but cannot reuse it: `sanitizeUrl` returns `escapeHtml(...)`, which would emit
 * `&amp;` into an RTF field. The scheme allowlist is deliberately identical to `sanitizeUrl`'s
 * and `sanitizeMarkdownUrl`'s, so all three text generators agree on what a hyperlink may point at.
 *
 * **Additionally rejects UNC paths (`\\host\share`), which the HTML allowlist does not.** In a
 * browser `\\evil.com\share` is an inert relative path; in Word it is a live UNC reference that
 * triggers an SMB fetch and an NTLM handshake on click, which is a credential-leak vector rather
 * than a rendering quirk. That asymmetry is why this is a separate function and not a flag on
 * `sanitizeUrl` - the HTML helper must NOT gain this behaviour, since there the path is harmless
 * and rejecting it would break legitimate relative links.
 *
 * Returns `''` for a rejected URL; callers emit the link text without the field wrapper, matching
 * how HTML degrades to `href=""` and Markdown to `[text]()`.
 */
export declare function sanitizeRtfUrl(url: string): string;
/**
 * Escapes text for RTF: neutralizes the control/group metacharacters `\ { }`
 * (which would otherwise inject RTF control words or groups), encodes the double
 * quote (so a hyperlink field argument can't be terminated early), and hex/unicode
 * encodes non-ASCII characters.
 */
export declare function escapeRtf(text: string): string;
/**
 * Escapes document text for a Markdown text position. Markdown passes raw HTML
 * through to the renderer, so a `<` that begins an HTML tag or comment must be
 * neutralized to prevent `<script>`/`<img onerror>` injection when the Markdown
 * is later rendered to HTML.
 *
 * Deliberately narrow — only a `<` immediately followed by a letter, `/`, `!` or
 * `?` (i.e. one that actually opens a tag/comment/PI, matching how browsers
 * detect tags) is encoded. A bare `<` (e.g. `a < b`), `>`, `&`, `[]` and other
 * Markdown metacharacters are left untouched: they can't start a tag, and
 * MarkdownParser round-trips this output without decoding entities, so encoding
 * them would corrupt re-parsed content. URL schemes are handled by
 * sanitizeMarkdownUrl.
 */
export declare function markdownEscapeText(text: string): string;
/**
 * Sanitizes a document-supplied URL for a Markdown `[text](url)` / `![alt](url)`
 * target. Rejects script-executing schemes (returning '' → a dead link) and
 * percent-encodes the characters that would break out of the `(...)` or inject
 * markup. `&` is preserved so query strings survive; set `allowDataImage` for
 * image targets so embedded `data:image/*` URIs are permitted.
 */
export declare function sanitizeMarkdownUrl(url: string, opts?: {
    allowDataImage?: boolean;
}): string;
