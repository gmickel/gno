import { describe, expect, test } from "bun:test";

import { ClipperGateway, ClipperGatewayError } from "../src/gateway";
import {
  grant,
  jsonResponse,
  payload,
  previewResponse,
  receiptResponse,
} from "./fixtures";

describe("browser clipper loopback gateway", () => {
  test("sends exact preview and capture requests without cookies", async () => {
    const requests: Request[] = [];
    const requestOptions: RequestInit[] = [];
    const fetcher = async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      requestOptions.push(init ?? {});
      requests.push(new Request(input, init));
      return requests.length === 1
        ? jsonResponse(previewResponse)
        : jsonResponse(receiptResponse, 202, {
            "Idempotent-Replay": "true",
          });
    };
    const gateway = new ClipperGateway(
      "http://127.0.0.1:3000",
      fetcher as typeof fetch
    );

    const preview = await gateway.preview(payload, grant);
    const capture = await gateway.capture(
      {
        payload,
        previewDigest: preview.preview.digest,
        idempotencyKey: "stable-key",
      },
      grant
    );
    expect(capture.replayed).toBeTrue();
    expect(capture.receipt.uri).toBe(receiptResponse.uri);
    expect(requestOptions[0]?.credentials).toBe("omit");
    expect(await requests[0]?.json()).toEqual(payload);
    expect(requests[1]?.headers.get("Idempotency-Key")).toBe("stable-key");
    expect(await requests[1]?.json()).toEqual({
      payload,
      previewDigest: "4".repeat(64),
    });

    const conflict = await new ClipperGateway("http://127.0.0.1:3000", (() =>
      Promise.resolve(
        jsonResponse(
          {
            ...receiptResponse,
            created: false,
            collisionPolicyResult: "conflict",
          },
          409
        )
      )) as unknown as typeof fetch).capture(
      {
        payload,
        previewDigest: preview.preview.digest,
        idempotencyKey: "conflict-key",
      },
      grant
    );
    expect(conflict.receipt.collisionPolicyResult).toBe("conflict");
  });

  test("fails closed for remote origins, offline access, and unknown errors", async () => {
    expect(() => new ClipperGateway("https://example.com")).toThrow(
      "127.0.0.1"
    );
    expect(() => new ClipperGateway("http://127.0.0.1:3000/path")).toThrow(
      "origin"
    );

    const offline = new ClipperGateway("http://127.0.0.1:3000", (() =>
      Promise.reject(new Error("offline"))) as unknown as typeof fetch);
    const offlineError = await offline
      .preview(payload, grant)
      .catch((error: unknown) => error);
    expect(offlineError).toMatchObject({
      code: "CLIPPER_OFFLINE",
      retryable: true,
    });

    const unknown = new ClipperGateway("http://127.0.0.1:3000", (() =>
      Promise.resolve(
        jsonResponse(
          { error: { code: "NEW_SERVER_CODE", message: "unknown" } },
          409
        )
      )) as unknown as typeof fetch);
    const unknownError = await unknown
      .preview(payload, grant)
      .catch((error: unknown) => error);
    expect(unknownError).toBeInstanceOf(ClipperGatewayError);
    expect(unknownError).toMatchObject({
      code: "CLIPPER_INVALID_RESPONSE",
    });
  });

  test("fails closed for valid bodies on impossible HTTP statuses", async () => {
    const pairStatus = {
      schemaVersion: "1.0",
      status: "consumed",
    };
    const pairGateway = new ClipperGateway("http://127.0.0.1:3000", (() =>
      Promise.resolve(
        jsonResponse(pairStatus, 200)
      )) as unknown as typeof fetch);
    expect(
      await pairGateway.pollPair("b".repeat(64)).catch((error) => error)
    ).toMatchObject({ code: "CLIPPER_INVALID_RESPONSE" });

    const receiptGateway = new ClipperGateway("http://127.0.0.1:3000", (() =>
      Promise.resolve(
        jsonResponse(receiptResponse, 500)
      )) as unknown as typeof fetch);
    expect(
      await receiptGateway
        .capture(
          {
            payload,
            previewDigest: "4".repeat(64),
            idempotencyKey: "stable-key",
          },
          grant
        )
        .catch((error) => error)
    ).toMatchObject({ code: "CLIPPER_INVALID_RESPONSE" });

    const revokeGateway = new ClipperGateway("http://127.0.0.1:3000", (() =>
      Promise.resolve(
        jsonResponse({ message: "Unauthorized" }, 401)
      )) as unknown as typeof fetch);
    expect(
      await revokeGateway.revoke(grant).catch((error) => error)
    ).toMatchObject({ code: "CLIPPER_INVALID_RESPONSE" });
  });
});
