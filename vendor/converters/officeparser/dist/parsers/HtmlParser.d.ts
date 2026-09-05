import { FullOfficeParserConfig, OfficeParserAST } from '../types.js';
export declare const parseHtml: (buffer: Buffer, config: FullOfficeParserConfig) => Promise<OfficeParserAST>;
