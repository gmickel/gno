/**
 * Environment detection and safe utility wrappers.
 */
/**
 * Detect if we are running in a browser environment.
 */
export declare const isBrowser: boolean;
/**
 * Supported Node.js-only features that require explicit guarding for browser compatibility.
 */
export type NodeFeature = 'fs' | 'path-parsing' | 'pdf-worker-auto-resolution';
/**
 * Throws an error if attempted to use Node.js-specific features in the browser.
 *
 * @param feature - The Node.js feature being accessed
 * @throws {Error} Clear error message directing browser users to use Buffers
 */
export declare function assertNode(feature: NodeFeature): void;
/**
 * Polyfills environment features not available globally (required for Node.js < 20).
 * This shim provides enough properties for pdfjs-dist 5.x to calculate
 * text coordinates and transformations, and guards against modern RegExp flags.
 */
export declare function ensureEnvPolyfills(): void;
/**
 * Backward-compatible alias for ensureEnvPolyfills.
 * @deprecated Use ensureEnvPolyfills instead.
 */
export declare const ensureDomMatrix: typeof ensureEnvPolyfills;
