import { FullOfficeParserConfig, OfficeParserAST } from '../types.js';
export declare const parseMarkdown: (buffer: Buffer, config: FullOfficeParserConfig) => Promise<OfficeParserAST>;
