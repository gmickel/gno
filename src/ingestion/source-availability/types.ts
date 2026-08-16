/**
 * Platform-neutral source-availability policy contract.
 * Controls whether source content materialization is allowed during ingestion.
 * Distinct from collection egress/privacy policy.
 *
 * @module src/ingestion/source-availability/types
 */

import {
  DEFAULT_SOURCE_AVAILABILITY,
  SOURCE_AVAILABILITY_MODES,
  type SourceAvailabilityMode,
} from "../../config/types";

export {
  DEFAULT_SOURCE_AVAILABILITY,
  SOURCE_AVAILABILITY_MODES,
  type SourceAvailabilityMode,
};

/**
 * Distinct fail-closed / skip outcomes for guarded source content access.
 * CLOUD_* and DATALESS_DIRECTORY are skips (not conversion errors).
 * Others fail closed as errors. Directory-boundary unknowns preserve indexed
 * descendants (unproven absence) rather than proving deletion.
 */
export const SOURCE_AVAILABILITY_CODES = [
  "CLOUD_PLACEHOLDER",
  "CLOUD_PARTIAL",
  "DATALESS_DIRECTORY",
  "SOURCE_AVAILABILITY_UNSUPPORTED",
  "SOURCE_AVAILABILITY_POLICY_FAILED",
  "SOURCE_AVAILABILITY_UNKNOWN",
  "PERMISSION",
  "NOT_FOUND",
  "NOT_FILE",
  "IO_ERROR",
] as const;
export type SourceAvailabilityCode = (typeof SOURCE_AVAILABILITY_CODES)[number];

/** Codes that must surface as skipped (not conversion/store errors). */
export const SOURCE_AVAILABILITY_SKIP_CODES = new Set<SourceAvailabilityCode>([
  "CLOUD_PLACEHOLDER",
  "CLOUD_PARTIAL",
  "DATALESS_DIRECTORY",
]);

/**
 * Directory / prefix outcomes that must not prove descendant absence.
 * Includes fail-closed errors where enumeration safety is unknown.
 */
export const SOURCE_AVAILABILITY_UNPROVEN_PREFIX_CODES =
  new Set<SourceAvailabilityCode>([
    "DATALESS_DIRECTORY",
    "SOURCE_AVAILABILITY_UNSUPPORTED",
    "SOURCE_AVAILABILITY_POLICY_FAILED",
    "SOURCE_AVAILABILITY_UNKNOWN",
    "PERMISSION",
    "IO_ERROR",
    "NOT_FOUND",
    "NOT_FILE",
  ]);

export type SourceReadSuccess = {
  ok: true;
  bytes: Uint8Array;
};

export type SourceReadFailure = {
  ok: false;
  code: SourceAvailabilityCode;
  message: string;
  /** Optional low-level errno for diagnostics (never required by callers). */
  errno?: number | null;
};

export type SourceReadResult = SourceReadSuccess | SourceReadFailure;

/**
 * Single content-boundary port: one guarded read supplies bytes for
 * sniff/hash/conversion and record-import open paths.
 */
export interface SourceContentReaderPort {
  readonly mode: SourceAvailabilityMode;
  /**
   * Read all source bytes under the active availability policy.
   * Local mode rechecks only at this byte-consumption boundary.
   */
  readAll(absPath: string, expectedSize?: number): Promise<SourceReadResult>;
}

/** Amortized directory-boundary classification (not per discovered file). */
export type DirectoryAvailabilityResult =
  | { kind: "available" }
  | {
      kind: "dataless";
      code: "DATALESS_DIRECTORY";
      message: string;
    }
  | {
      kind: "error";
      code: SourceAvailabilityCode;
      message: string;
      errno?: number | null;
    };

export type DirectoryReadResult<T> =
  | { kind: "available"; value: T }
  | Exclude<DirectoryAvailabilityResult, { kind: "available" }>;

export type SynchronousDirectoryRead<T> = () => T &
  (T extends PromiseLike<unknown> ? never : unknown);

export interface DirectoryAvailabilityPort {
  readonly mode: SourceAvailabilityMode;
  /** Classify one directory before descent or ancestor-prefix checks. */
  classify(absPath: string): Promise<DirectoryAvailabilityResult>;
  /** Reclassify and synchronously enumerate while the policy remains active. */
  readDirectory<T>(
    absPath: string,
    read: SynchronousDirectoryRead<T>
  ): DirectoryReadResult<T>;
}

export function isSourceAvailabilitySkip(
  code: string | undefined
): code is "CLOUD_PLACEHOLDER" | "CLOUD_PARTIAL" | "DATALESS_DIRECTORY" {
  return (
    code === "CLOUD_PLACEHOLDER" ||
    code === "CLOUD_PARTIAL" ||
    code === "DATALESS_DIRECTORY"
  );
}

export function isUnprovenAbsenceCode(code: string | undefined): boolean {
  return (
    typeof code === "string" &&
    SOURCE_AVAILABILITY_UNPROVEN_PREFIX_CODES.has(
      code as SourceAvailabilityCode
    )
  );
}

export function sourceAvailabilityMessage(
  code: SourceAvailabilityCode,
  detail?: string
): string {
  const base: Record<SourceAvailabilityCode, string> = {
    CLOUD_PLACEHOLDER:
      "Source is a cloud placeholder; local mode refused materialization",
    CLOUD_PARTIAL:
      "Source has partial cloud content; local mode refused incomplete materialization",
    DATALESS_DIRECTORY:
      "Directory is dataless or availability-unknown; local mode refused descent",
    SOURCE_AVAILABILITY_UNSUPPORTED:
      "sourceAvailability local is not supported on this platform or filesystem",
    SOURCE_AVAILABILITY_POLICY_FAILED:
      "Failed to establish no-materialization I/O policy for sourceAvailability local",
    SOURCE_AVAILABILITY_UNKNOWN:
      "Source availability could not be determined safely; local mode fails closed",
    PERMISSION: "Permission denied reading source file",
    NOT_FOUND: "Source file not found",
    NOT_FILE: "Path is not a regular file",
    IO_ERROR: "I/O error reading source file",
  };
  if (detail && detail.length > 0) {
    return `${base[code]}: ${detail}`;
  }
  return base[code];
}
