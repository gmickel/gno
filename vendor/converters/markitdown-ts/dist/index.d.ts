import { LanguageModel } from 'ai';
import mammoth from 'mammoth';

type ConverterResult = {
    title: string | null;
    markdown: string;
    /** @deprecated Use `markdown` instead. */
    text_content: string;
} | null | undefined;
type ConverterOptions = {
    llmModel?: LanguageModel;
    llmPrompt?: string;
    file_extension?: string;
    url?: string;
    fetch?: typeof fetch;
    enableYoutubeTranscript?: boolean;
    youtubeTranscriptLanguage?: string;
    cleanupExtracted?: boolean;
    _parent_converters?: DocumentConverter[];
} & MammothOptions;
type MammothOptions = Parameters<typeof mammoth.convertToHtml>[1];
interface DocumentConverter {
    convert(source: string | Buffer, options: ConverterOptions): Promise<ConverterResult>;
}

declare class MarkItDown {
    private readonly converters;
    constructor();
    /**
     * Converts a source from a file path, URL, or Response object.
     */
    convert(source: string | Response, options?: ConverterOptions): Promise<ConverterResult>;
    /**
     * Converts a source from an in-memory Buffer.
     */
    convertBuffer(source: Buffer, options: ConverterOptions & {
        file_extension: string;
    }): Promise<ConverterResult>;
    private convert_url;
    private convert_response;
    private convert_local;
    private _convert;
    private register_converter;
}

export { MarkItDown };
