import { describe, expect, mock, test } from "bun:test";

import {
  approveClipperPair,
  consumeClipperPairLaunch,
} from "../../../src/serve/public/lib/clipper-approval";

describe("browser clipper approval launch", () => {
  test("accepts one exact fragment and scrubs it synchronously", () => {
    const replaceState = mock(() => undefined);
    const pairId = "a".repeat(64);
    expect(
      consumeClipperPairLaunch(
        {
          pathname: "/clipper/pair",
          search: "",
          hash: `#pairId=${pairId}`,
        } as Location,
        { replaceState } as unknown as History
      )
    ).toEqual({ pairId, valid: true });
    expect(replaceState).toHaveBeenCalledWith({}, "", "/clipper/pair");
  });

  test("rejects query strings, codes, extra fields, and malformed IDs", () => {
    for (const location of [
      {
        pathname: "/clipper/pair",
        search: "?pairId=x",
        hash: "",
      },
      {
        pathname: "/clipper/pair",
        search: "",
        hash: `#pairId=${"a".repeat(64)}&pairingCode=12345678`,
      },
      {
        pathname: "/clipper/pair",
        search: "",
        hash: "#pairId=short",
      },
    ]) {
      const replaceState = mock(() => undefined);
      expect(
        consumeClipperPairLaunch(
          location as Location,
          { replaceState } as unknown as History
        )
      ).toEqual({ pairId: null, valid: false });
      expect(replaceState).toHaveBeenCalledWith({}, "", "/clipper/pair");
    }
  });
});

const errorResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const approveWithError = async (body: unknown, status: number) =>
  await approveClipperPair("a".repeat(64), "12345678", (async () =>
    errorResponse(body, status)) as unknown as typeof fetch).catch(
    (error: unknown) => error
  );

describe("browser clipper approval error parsing", () => {
  test("accepts details only in the exact pairing and shape that exists", async () => {
    const details = {
      reason: "PATH_OUTSIDE_COLLECTION",
      relPath: "clips/article.md",
    };
    // The only code that carries details is still parsed as itself.
    expect(
      await approveWithError(
        {
          error: {
            code: "VALIDATION",
            message: "Refused a destination outside the collection.",
            details,
          },
        },
        409
      )
    ).toMatchObject({ code: "VALIDATION" });

    // Details beside a code that never produces them, or carrying an arbitrary
    // value, is a response no pairing route emits: refuse to interpret it.
    for (const body of [
      {
        error: {
          code: "CLIPPER_UNAUTHORIZED",
          message: "Unauthorized",
          details,
        },
      },
      {
        error: {
          code: "VALIDATION",
          message: "Refused",
          details: { token: "secret" },
        },
      },
    ]) {
      expect(await approveWithError(body, 401)).toMatchObject({
        code: "CLIPPER_INVALID_RESPONSE",
      });
    }
  });
});
