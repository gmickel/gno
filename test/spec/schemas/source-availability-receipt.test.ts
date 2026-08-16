/**
 * Contract: sync/job-status receipts distinguish source-availability outcomes.
 * sourceAvailability is distinct from egressPolicy; no separate public knob.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import {
  SOURCE_AVAILABILITY_CODES,
  SOURCE_AVAILABILITY_SKIP_CODES,
  SOURCE_AVAILABILITY_UNPROVEN_PREFIX_CODES,
  isSourceAvailabilitySkip,
  isUnprovenAbsenceCode,
} from "../../../src/ingestion/source-availability";
import { assertValid, loadSchema } from "./validator";

describe("source-availability receipt contract", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("mcp-job-status");
  });

  test("skip codes are the cloud/dataless triad only", () => {
    expect([...SOURCE_AVAILABILITY_SKIP_CODES].sort()).toEqual([
      "CLOUD_PARTIAL",
      "CLOUD_PLACEHOLDER",
      "DATALESS_DIRECTORY",
    ]);
    for (const code of SOURCE_AVAILABILITY_SKIP_CODES) {
      expect(isSourceAvailabilitySkip(code)).toBe(true);
    }
    expect(isSourceAvailabilitySkip("SOURCE_AVAILABILITY_UNSUPPORTED")).toBe(
      false
    );
    expect(isSourceAvailabilitySkip("IO_ERROR")).toBe(false);
  });

  test("unproven prefix codes preserve descendants (not proven deletion)", () => {
    for (const code of [
      "DATALESS_DIRECTORY",
      "SOURCE_AVAILABILITY_UNSUPPORTED",
      "SOURCE_AVAILABILITY_POLICY_FAILED",
      "SOURCE_AVAILABILITY_UNKNOWN",
      "PERMISSION",
      "IO_ERROR",
      "NOT_FOUND",
      "NOT_FILE",
    ] as const) {
      expect(SOURCE_AVAILABILITY_UNPROVEN_PREFIX_CODES.has(code)).toBe(true);
      expect(isUnprovenAbsenceCode(code)).toBe(true);
    }
    // Cloud file skips are not unproven *directory prefixes*.
    expect(isUnprovenAbsenceCode("CLOUD_PLACEHOLDER")).toBe(false);
    expect(isUnprovenAbsenceCode("CLOUD_PARTIAL")).toBe(false);
  });

  test.each([
    {
      status: "skipped" as const,
      errorCode: "CLOUD_PLACEHOLDER",
      errorMessage:
        "Source is a cloud placeholder; local mode refused materialization",
    },
    {
      status: "skipped" as const,
      errorCode: "CLOUD_PARTIAL",
      errorMessage:
        "Source has partial cloud content; local mode refused incomplete materialization",
    },
    {
      status: "skipped" as const,
      errorCode: "DATALESS_DIRECTORY",
      errorMessage:
        "Directory is dataless or availability-unknown; local mode refused descent",
    },
    {
      status: "error" as const,
      errorCode: "SOURCE_AVAILABILITY_UNSUPPORTED",
      errorMessage:
        "sourceAvailability local is not supported on this platform or filesystem",
    },
    {
      status: "error" as const,
      errorCode: "SOURCE_AVAILABILITY_POLICY_FAILED",
      errorMessage:
        "Failed to establish no-materialization I/O policy for sourceAvailability local",
    },
    {
      status: "error" as const,
      errorCode: "SOURCE_AVAILABILITY_UNKNOWN",
      errorMessage:
        "Source availability could not be determined safely; local mode fails closed",
    },
  ])(
    "job-status accepts $errorCode as $status",
    ({ status, errorCode, errorMessage }) => {
      const payload = {
        jobId: "job-sa-1",
        type: "sync",
        status: "completed",
        startedAt: "2026-08-16T12:00:00Z",
        completedAt: "2026-08-16T12:00:01Z",
        serverInstanceId: "550e8400-e29b-41d4-a716-446655440000",
        result: {
          collections: [
            {
              collection: "drive",
              filesProcessed: 1,
              filesAdded: 0,
              filesUpdated: 0,
              filesUnchanged: 0,
              filesErrored: status === "error" ? 1 : 0,
              filesSkipped: status === "skipped" ? 1 : 0,
              filesMarkedInactive: 0,
              durationMs: 10,
              errors: [
                {
                  relPath: "cloud/note.md",
                  code: errorCode,
                  message: errorMessage,
                },
              ],
              files: [
                {
                  relPath: "cloud/note.md",
                  status,
                  errorCode,
                  errorMessage,
                },
              ],
            },
          ],
          totalDurationMs: 10,
          totalFilesProcessed: 1,
          totalFilesAdded: 0,
          totalFilesUpdated: 0,
          totalFilesErrored: status === "error" ? 1 : 0,
          totalFilesSkipped: status === "skipped" ? 1 : 0,
        },
      };
      expect(assertValid(payload, schema)).toBe(true);
    }
  );

  test("eligible file has no availability errorCode", () => {
    const payload = {
      jobId: "job-sa-2",
      type: "index",
      status: "completed",
      startedAt: "2026-08-16T12:00:00Z",
      completedAt: "2026-08-16T12:00:02Z",
      serverInstanceId: "550e8400-e29b-41d4-a716-446655440000",
      typedResult: {
        kind: "sync",
        value: {
          collections: [
            {
              collection: "notes",
              filesProcessed: 1,
              filesAdded: 1,
              filesUpdated: 0,
              filesUnchanged: 0,
              filesErrored: 0,
              filesSkipped: 0,
              filesMarkedInactive: 0,
              durationMs: 5,
              errors: [],
              files: [
                {
                  relPath: "local/note.md",
                  status: "added",
                  docid: "abc",
                  mirrorHash:
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                },
              ],
            },
          ],
          totalDurationMs: 5,
          totalFilesProcessed: 1,
          totalFilesAdded: 1,
          totalFilesUpdated: 0,
          totalFilesErrored: 0,
          totalFilesSkipped: 0,
        },
      },
    };
    expect(assertValid(payload, schema)).toBe(true);
  });

  test("SOURCE_AVAILABILITY_CODES covers the closed set", () => {
    expect(SOURCE_AVAILABILITY_CODES).toEqual([
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
    ]);
  });
});
