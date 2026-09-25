import { beforeAll, describe, expect, test } from "bun:test";

import { CLI_ERROR_CODES } from "../../../src/cli/errors";
import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("error schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("error");
  });

  test("code enum lists exactly the CLI error model's codes", () => {
    const codeSchema = (
      schema as {
        properties: { error: { properties: { code: { enum: string[] } } } };
      }
    ).properties.error.properties.code;
    expect(codeSchema.enum.toSorted()).toEqual([...CLI_ERROR_CODES].toSorted());
  });

  describe("valid inputs", () => {
    test("validates error fixture", async () => {
      const fixture = await Bun.file(
        "test/fixtures/outputs/error-validation.json"
      ).json();
      expect(assertValid(fixture, schema)).toBe(true);
    });

    test("validates VALIDATION error", () => {
      const error = {
        error: {
          code: "VALIDATION",
          message: "Invalid argument",
        },
      };
      expect(assertValid(error, schema)).toBe(true);
    });

    test("validates RUNTIME error", () => {
      const error = {
        error: {
          code: "RUNTIME",
          message: "Database connection failed",
        },
      };
      expect(assertValid(error, schema)).toBe(true);
    });

    test("validates error with details", () => {
      const error = {
        error: {
          code: "VALIDATION",
          message: "Missing required field",
          details: {
            field: "query",
            command: "search",
            suggestion: "Provide a search query",
          },
        },
      };
      expect(assertValid(error, schema)).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    test("rejects missing error object", () => {
      const error = {
        code: "VALIDATION",
        message: "Invalid",
      };
      expect(assertInvalid(error, schema)).toBe(true);
    });

    test("rejects invalid error code", () => {
      const error = {
        error: {
          code: "UNKNOWN",
          message: "Something went wrong",
        },
      };
      expect(assertInvalid(error, schema)).toBe(true);
    });

    test("rejects missing code", () => {
      const error = {
        error: {
          message: "Something went wrong",
        },
      };
      expect(assertInvalid(error, schema)).toBe(true);
    });

    test("rejects missing message", () => {
      const error = {
        error: {
          code: "VALIDATION",
        },
      };
      expect(assertInvalid(error, schema)).toBe(true);
    });
  });
});
