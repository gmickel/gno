import { FullOfficeParserConfig, OfficeParserAST } from '../types.js';
/**
 * Parses an EPUB file (a ZIP archive of XHTML content plus an OPF manifest) into the
 * unified OfficeParserAST. Each spine item is parsed via the existing `HtmlParser` and
 * the resulting content/attachments are concatenated in reading order - EPUB is
 * essentially a sequence of XHTML documents, so there's no need for a bespoke content model.
 */
export declare const parseEpub: (buffer: Buffer, config: FullOfficeParserConfig) => Promise<OfficeParserAST>;
