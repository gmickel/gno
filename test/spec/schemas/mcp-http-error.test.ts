import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("HTTP MCP boundary error schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("mcp-http-error");
  });

  test("accepts every stable redacted boundary failure", () => {
    for (const message of [
      "Unauthorized",
      "Forbidden",
      "Request body too large",
      "Too many requests",
      "Resident runtime unavailable",
    ]) {
      expect(
        assertValid(
          {
            jsonrpc: "2.0",
            error: { code: -32_000, message },
            id: null,
          },
          schema
        )
      ).toBe(true);
    }
  });

  test("rejects diagnostic details that could expose credentials", () => {
    expect(
      assertInvalid(
        {
          jsonrpc: "2.0",
          error: {
            code: -32_000,
            message: "Unauthorized",
            details: { authorization: "Bearer secret" },
          },
          id: null,
        },
        schema
      )
    ).toBe(true);
  });
});
