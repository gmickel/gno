/**
 * Centralized converter version tracking.
 *
 * Native converters use our own versioning.
 * Adapter versions MUST match the wrapped npm package version.
 *
 * When updating npm dependencies, update these versions too.
 * Run `bun pm ls markitdown-ts officeparser` to check current versions.
 */

/** Native converter versions (our own) */
export const NATIVE_VERSIONS = {
  markdown: "1.0.0",
  plaintext: "1.0.0",
} as const;

/**
 * Adapter versions - MUST match npm package versions.
 * Update these when running `bun update`.
 */
export const ADAPTER_VERSIONS = {
  "markitdown-ts": "0.0.8",
  officeparser: "6.0.4",
} as const;
