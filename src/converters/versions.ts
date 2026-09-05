/**
 * Centralized converter version tracking.
 *
 * Native converters use our own versioning.
 * Adapter versions identify upstream code and security-sensitive parser versions.
 * Update them when changing the vendored distributions or parser dependencies.
 * Upstream identities live in vendor/converters/upstream-manifest.json.
 */

/** Native converter versions (our own) */
export const NATIVE_VERSIONS = {
  markdown: "1.0.0",
  plaintext: "1.0.0",
} as const;

/**
 * Include repaired parser versions so existing converted content is invalidated.
 */
export const ADAPTER_VERSIONS = {
  "markitdown-ts": "0.0.10+xlsx.0.20.3",
  officeparser: "7.8.0+pdfjs.6.3.289",
} as const;
