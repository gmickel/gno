/**
 * Tests for converter error helpers.
 */

import { describe, expect, test } from "bun:test";

import type { ConvertInput } from "../../src/converters/types";

import {
  adapterError,
  convertError,
  corruptError,
  isRetryable,
  permissionError,
  timeoutError,
  tooLargeError,
  unsupportedError,
} from "../../src/converters/errors";
import { DEFAULT_LIMITS } from "../../src/converters/types";

function makeInput(overrides: Partial<ConvertInput>): ConvertInput {
  return {
    sourcePath: "/test/file.pdf",
    relativePath: "file.pdf",
    collection: "test",
    bytes: new Uint8Array(1000),
    mime: "application/pdf",
    ext: ".pdf",
    limits: DEFAULT_LIMITS,
    ...overrides,
  };
}

describe("convertError", () => {
  test("creates error with correct code", () => {
    const error = convertError("TIMEOUT", {
      message: "Test timeout",
      retryable: true,
      fatal: false,
      converterId: "test",
      sourcePath: "/test",
      mime: "test",
      ext: ".test",
    });

    expect(error.code).toBe("TIMEOUT");
    expect(error.message).toBe("Test timeout");
    expect(error.retryable).toBe(true);
  });
});

describe("isRetryable", () => {
  test("TIMEOUT is retryable", () => {
    expect(isRetryable("TIMEOUT")).toBe(true);
  });

  test("IO is retryable", () => {
    expect(isRetryable("IO")).toBe(true);
  });

  test("ADAPTER_FAILURE is retryable", () => {
    expect(isRetryable("ADAPTER_FAILURE")).toBe(true);
  });

  test("UNSUPPORTED is not retryable", () => {
    expect(isRetryable("UNSUPPORTED")).toBe(false);
  });

  test("PERMISSION is not retryable", () => {
    expect(isRetryable("PERMISSION")).toBe(false);
  });

  test("TOO_LARGE is not retryable", () => {
    expect(isRetryable("TOO_LARGE")).toBe(false);
  });

  test("CORRUPT is not retryable", () => {
    expect(isRetryable("CORRUPT")).toBe(false);
  });
});

describe("unsupportedError", () => {
  test("creates UNSUPPORTED error", () => {
    const input = makeInput({ mime: "video/mp4", ext: ".mp4" });
    const error = unsupportedError(input);

    expect(error.code).toBe("UNSUPPORTED");
    expect(error.message).toContain("video/mp4");
    expect(error.message).toContain(".mp4");
    expect(error.retryable).toBe(false);
  });
});

describe("tooLargeError", () => {
  test("creates TOO_LARGE error with size details", () => {
    const input = makeInput({
      bytes: new Uint8Array(200 * 1024 * 1024),
      limits: { ...DEFAULT_LIMITS, maxBytes: 100 * 1024 * 1024 },
    });
    const error = tooLargeError(input, "test-converter");

    expect(error.code).toBe("TOO_LARGE");
    expect(error.message).toContain("exceeds limit");
    expect(error.retryable).toBe(false);
    expect(error.details?.size).toBe(200 * 1024 * 1024);
    expect(error.details?.limit).toBe(100 * 1024 * 1024);
  });
});

describe("timeoutError", () => {
  test("creates TIMEOUT error", () => {
    const input = makeInput({
      limits: { ...DEFAULT_LIMITS, timeoutMs: 30_000 },
    });
    const error = timeoutError(input, "test-converter");

    expect(error.code).toBe("TIMEOUT");
    expect(error.message).toContain("30000ms");
    expect(error.retryable).toBe(true);
  });
});

describe("corruptError", () => {
  test("creates CORRUPT error", () => {
    const input = makeInput({});
    const cause = new Error("Parse failed");
    const error = corruptError(input, "test-converter", "Invalid file", cause);

    expect(error.code).toBe("CORRUPT");
    expect(error.message).toBe("Invalid file");
    expect(error.retryable).toBe(false);
    // Cause is normalized to { name, message } for safe serialization
    expect(error.cause).toEqual({ name: "Error", message: "Parse failed" });
  });
});

describe("adapterError", () => {
  test("creates ADAPTER_FAILURE error", () => {
    const input = makeInput({});
    const cause = new Error("Library error");
    const error = adapterError(
      input,
      "test-converter",
      "Conversion failed",
      cause
    );

    expect(error.code).toBe("ADAPTER_FAILURE");
    expect(error.message).toBe("Conversion failed");
    expect(error.retryable).toBe(true);
    // Cause is normalized to { name, message } for safe serialization
    expect(error.cause).toEqual({ name: "Error", message: "Library error" });
  });
});

describe("permissionError", () => {
  test("creates PERMISSION error", () => {
    const input = makeInput({});
    const cause = new Error("No password given");
    const error = permissionError(
      input,
      "test-converter",
      "File is password-protected",
      cause,
      { protection: "pdf" }
    );

    expect(error.code).toBe("PERMISSION");
    expect(error.message).toBe("File is password-protected");
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({ protection: "pdf" });
    expect(error.cause).toEqual({
      name: "Error",
      message: "No password given",
    });
  });
});
