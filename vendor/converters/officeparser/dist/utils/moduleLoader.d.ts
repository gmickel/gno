/**
 * Module Loader Utility
 *
 * Centralizes dynamic imports for ESM-only packages (like file-type and pdfjs-dist)
 * to maintain CommonJS compatibility while supporting modern ESM dependencies.
 *
 * This approach prevents TypeScript from transpiling dynamic import()
 * into require() when targeting CommonJS.
 */
import type * as FileTypeModule from 'file-type' with { 'resolution-mode': 'import' };
/**
 * Specialized loader for file-type
 */
export declare function loadFileType(): Promise<typeof FileTypeModule>;
/**
 * Specialized loader for pdfjs-dist
 */
export declare function loadPdfJs(): Promise<any>;
