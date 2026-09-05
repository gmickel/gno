/**
 * OCR (Optical Character Recognition) Utilities
 *
 * This module provides functions for extracting text from images using Tesseract.js.
 * Used when `config.ocr` is enabled to extract text from embedded images in documents.
 *
 * Includes a worker pool via OcrSchedulerManager to improve performance when
 * processing multiple images.
 *
 * @module ocrUtils
 */
import { OcrConfig } from '../types.js';
/**
 * Performs Optical Character Recognition (OCR) on an image to extract text.
 *
 * Uses Tesseract.js to recognize text in the provided image buffer.
 * This is useful for extracting text from screenshots, scanned documents,
 * charts with labels, or any image containing text.
 *
 * This function uses a shared worker pool to minimize initialization overhead.
 *
 * @param image - The image data as a Buffer, file path, or Blob
 * @param config - Optional configuration for language and custom worker paths
 * @returns A promise that resolves to the recognized text as a string
 * @throws {Error} If the image cannot be processed or Tesseract initialization fails
 *
 * @example
 * ```typescript
 * // Extract text from an English image
 * const text = await performOcr(imageBuffer, { language: 'eng' });
 * ```
 *
 * @see https://github.com/naptha/tesseract.js for supported languages and options
 */
export declare const performOcr: (image: Buffer | string, config?: OcrConfig) => Promise<string>;
/**
 * Terminates all OCR workers and cleans up resources.
 *
 * Should be called when the application is shutting down or OCR is no longer needed
 * to prevent memory leaks and dangling worker processes.
 */
export declare const terminateOcr: () => Promise<void>;
