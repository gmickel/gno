import { describe, expect, mock, test } from "bun:test";

import type { LocalStorageArea } from "../src/storage";

import { CLIPPER_PAIR_SESSION_KEY, ClipperController } from "../src/controller";
import {
  CLIPPER_STORAGE_KEY,
  readClipperState,
  writeClipperState,
} from "../src/storage";
import {
  extraction,
  grant,
  jsonResponse,
  payload,
  previewResponse,
  receiptResponse,
} from "./fixtures";

class MemoryStorage implements LocalStorageArea {
  values: Record<string, unknown> = {};
  async get(): Promise<Record<string, unknown>> {
    return { ...this.values };
  }
  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, items);
  }
}

const makeController = (
  local: MemoryStorage,
  session: MemoryStorage,
  fetcher: typeof fetch,
  opened: string[] = [],
  sleeps: number[] = []
) =>
  new ClipperController({
    local,
    session,
    extensionOrigin: `chrome-extension://${"a".repeat(32)}`,
    fetcher,
    openApproval: async (url) => {
      opened.push(url);
    },
    extract: async () => extraction,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    randomKey: () => "persisted-idempotency-key",
  });

describe("browser clipper controller", () => {
  test("pairs only the exact runtime origin and keeps pair secrets transient", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const opened: string[] = [];
    const pairId = "b".repeat(64);
    const responses = [
      jsonResponse({
        schemaVersion: "1.0",
        pairId,
        pairingCode: "12345678",
        expiresAt: "2099-07-24T08:05:00.000Z",
        origin: `chrome-extension://${"a".repeat(32)}`,
        approvalPath: "/api/clipper/pair/approve",
      }),
      jsonResponse({
        schemaVersion: "1.0",
        status: "approved",
        ...grant,
      }),
    ];
    const fetcher = (() =>
      Promise.resolve(responses.shift()!)) as unknown as typeof fetch;
    const controller = makeController(local, session, fetcher, opened);

    const started = await controller.startPair("http://127.0.0.1:3000");
    expect(started.pairingCode).toBe("12345678");
    expect(opened).toEqual([
      `http://127.0.0.1:3000/clipper/pair#pairId=${pairId}`,
    ]);
    expect(JSON.stringify(local.values)).not.toContain(pairId);
    expect(session.values[CLIPPER_PAIR_SESSION_KEY]).toMatchObject({ pairId });

    expect(await controller.pollPair()).toMatchObject({ status: "approved" });
    expect(session.values[CLIPPER_PAIR_SESSION_KEY]).toBeNull();
    expect(await readClipperState(local)).toMatchObject({
      gatewayOrigin: "http://127.0.0.1:3000",
      grant,
    });
  });

  test("rejects mismatched extension origin before local storage", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const controller = makeController(local, session, (() =>
      Promise.resolve(
        jsonResponse({
          schemaVersion: "1.0",
          pairId: "b".repeat(64),
          pairingCode: "12345678",
          expiresAt: "2099-07-24T08:05:00.000Z",
          origin: `chrome-extension://${"c".repeat(32)}`,
          approvalPath: "/api/clipper/pair/approve",
        })
      )) as unknown as typeof fetch);
    const mismatch = await controller
      .startPair("http://127.0.0.1:3000")
      .catch((error: unknown) => error);
    expect(mismatch).toBeInstanceOf(Error);
    expect((mismatch as Error).message).toContain(
      "invalid browser pairing state"
    );
    expect(local.values[CLIPPER_STORAGE_KEY]).toBeUndefined();
  });

  test("accepts a foreground-validated pair without worker network access", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const opened: string[] = [];
    const fetcher = mock(async () => {
      throw new Error("service worker must not start pairing");
    });
    const controller = makeController(
      local,
      session,
      fetcher as unknown as typeof fetch,
      opened
    );
    const pairId = "d".repeat(64);

    await controller.acceptStartedPair("http://127.0.0.1:3000", {
      pairId,
      pairingCode: "87654321",
      expiresAt: "2099-07-24T08:05:00.000Z",
      origin: `chrome-extension://${"a".repeat(32)}`,
      approvalPath: "/api/clipper/pair/approve",
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(session.values[CLIPPER_PAIR_SESSION_KEY]).toMatchObject({ pairId });
    expect(opened).toEqual([
      `http://127.0.0.1:3000/clipper/pair#pairId=${pairId}`,
    ]);
  });

  test("rejects hostile foreground pair handoff before session or navigation", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const opened: string[] = [];
    const controller = makeController(
      local,
      session,
      (() => Promise.reject(new Error("unused"))) as unknown as typeof fetch,
      opened
    );
    const started = {
      pairId: "d".repeat(64),
      pairingCode: "87654321",
      expiresAt: "2099-07-24T08:05:00.000Z",
      origin: `chrome-extension://${"a".repeat(32)}`,
      approvalPath: "/api/clipper/pair/approve" as const,
    };

    for (const gatewayOrigin of [
      "https://attacker.example",
      "http://127.0.0.1:3000/redirect",
    ]) {
      expect(
        controller.acceptStartedPair(gatewayOrigin, started)
      ).rejects.toBeInstanceOf(Error);
    }
    expect(session.values[CLIPPER_PAIR_SESSION_KEY]).toBeNull();
    expect(opened).toEqual([]);
  });

  test("persists one pending write across restart and reuses its key offline", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    await writeClipperState(
      {
        gatewayOrigin: "http://127.0.0.1:3000",
        grant: { ...grant, expiresAt: "2099-08-24T08:00:00.000Z" },
        pending: null,
      },
      local
    );
    const offline = makeController(local, session, (() =>
      Promise.reject(new Error("offline"))) as unknown as typeof fetch);
    const offlineError = await offline
      .capture(payload, "4".repeat(64))
      .catch((error: unknown) => error);
    expect(offlineError).toMatchObject({ code: "CLIPPER_OFFLINE" });
    const pending = (await readClipperState(local)).pending;
    expect(pending?.idempotencyKey).toBe("persisted-idempotency-key");

    let capturedKey: string | null = null;
    const resumed = makeController(local, session, (async (input, init) => {
      capturedKey = new Request(input, init).headers.get("Idempotency-Key");
      return jsonResponse(receiptResponse, 202);
    }) as typeof fetch);
    expect((await resumed.capture(payload, "4".repeat(64))).receipt.uri).toBe(
      receiptResponse.uri
    );
    expect(capturedKey ?? "").toBe("persisted-idempotency-key");
    expect((await readClipperState(local)).pending).toBeNull();
  });

  test("reopens with a recoverable pending write and can retry or stop it", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const pending = {
      payload,
      previewDigest: "4".repeat(64),
      idempotencyKey: "persisted-idempotency-key",
    };
    await writeClipperState(
      {
        gatewayOrigin: "http://127.0.0.1:3000",
        grant: { ...grant, expiresAt: "2099-08-24T08:00:00.000Z" },
        pending,
      },
      local
    );
    const requests: Request[] = [];
    const resumed = makeController(local, session, (async (input, init) => {
      requests.push(new Request(input, init));
      return jsonResponse(receiptResponse, 202);
    }) as typeof fetch);

    expect(await resumed.state()).toMatchObject({
      pending: { payload, previewDigest: pending.previewDigest },
    });
    await resumed.resumePending();
    expect(requests[0]?.headers.get("Idempotency-Key")).toBe(
      pending.idempotencyKey
    );
    expect(await requests[0]?.json()).toEqual({
      payload,
      previewDigest: pending.previewDigest,
    });

    await writeClipperState(
      {
        gatewayOrigin: "http://127.0.0.1:3000",
        grant: { ...grant, expiresAt: "2099-08-24T08:00:00.000Z" },
        pending,
      },
      local
    );
    await resumed.discardPending();
    expect((await readClipperState(local)).pending).toBeNull();
  });

  test("refreshes a lost preview, backs off pending, and preserves destination", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const sleeps: number[] = [];
    await writeClipperState(
      {
        gatewayOrigin: "http://127.0.0.1:3000",
        grant: { ...grant, expiresAt: "2099-08-24T08:00:00.000Z" },
        pending: null,
      },
      local
    );
    const refreshedPreview = {
      ...previewResponse,
      preview: { ...previewResponse.preview, digest: "5".repeat(64) },
    };
    const responses = [
      jsonResponse(
        {
          error: {
            code: "CLIPPER_PREVIEW_REQUIRED",
            message: "Fresh preview required",
          },
        },
        409
      ),
      jsonResponse(refreshedPreview),
      jsonResponse(
        {
          error: {
            code: "CLIPPER_IDEMPOTENCY_PENDING",
            message: "Still in progress",
          },
        },
        409
      ),
      jsonResponse(receiptResponse, 202),
    ];
    const requestBodies: unknown[] = [];
    const controller = makeController(
      local,
      session,
      (async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "POST") requestBodies.push(await request.json());
        return responses.shift()!;
      }) as typeof fetch,
      [],
      sleeps
    );
    await controller.capture(payload, "4".repeat(64));
    expect(sleeps).toEqual([250, 500]);
    expect(requestBodies.at(-1)).toEqual({
      payload,
      previewDigest: "5".repeat(64),
    });
    expect(
      (requestBodies.at(-1) as { payload: typeof payload }).payload.destination
    ).toEqual(payload.destination);
  });

  test("resumes a service-worker restart after an internal preview refresh", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    await writeClipperState(
      {
        gatewayOrigin: "http://127.0.0.1:3000",
        grant: { ...grant, expiresAt: "2099-08-24T08:00:00.000Z" },
        pending: null,
      },
      local
    );
    const responses: Array<Response | Error> = [
      jsonResponse(
        {
          error: {
            code: "CLIPPER_PREVIEW_REQUIRED",
            message: "Fresh preview required",
          },
        },
        409
      ),
      jsonResponse({
        ...previewResponse,
        preview: { ...previewResponse.preview, digest: "5".repeat(64) },
      }),
      new Error("offline"),
      new Error("offline"),
      new Error("offline"),
      new Error("offline"),
    ];
    const interrupted = makeController(local, session, (() => {
      const response = responses.shift()!;
      return response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response);
    }) as unknown as typeof fetch);
    const interruptedError = await interrupted
      .capture(payload, "4".repeat(64))
      .catch((error: unknown) => error);
    expect(interruptedError).toMatchObject({ code: "CLIPPER_OFFLINE" });
    expect((await readClipperState(local)).pending).toMatchObject({
      previewDigest: "5".repeat(64),
      idempotencyKey: "persisted-idempotency-key",
    });

    let resumedBody: unknown;
    const resumed = makeController(local, session, (async (input, init) => {
      resumedBody = await new Request(input, init).json();
      return jsonResponse(receiptResponse, 202);
    }) as typeof fetch);
    await resumed.capture(payload, "4".repeat(64));
    expect(resumedBody).toEqual({
      payload,
      previewDigest: "5".repeat(64),
    });
  });

  test("never auto-refreshes a mismatched preview into a write", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    await writeClipperState(
      {
        gatewayOrigin: "http://127.0.0.1:3000",
        grant: { ...grant, expiresAt: "2099-08-24T08:00:00.000Z" },
        pending: null,
      },
      local
    );
    const requests: Request[] = [];
    const controller = makeController(local, session, (async (input, init) => {
      requests.push(new Request(input, init));
      return jsonResponse(
        {
          error: {
            code: "CLIPPER_PREVIEW_MISMATCH",
            message: "Preview no longer matches the capture.",
          },
        },
        409
      );
    }) as typeof fetch);

    const captureError = await controller
      .capture(payload, "4".repeat(64))
      .catch((error: unknown) => error);

    expect(captureError).toMatchObject({
      code: "CLIPPER_PREVIEW_MISMATCH",
      refreshPreview: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://127.0.0.1:3000/api/capture/clip");
    expect((await readClipperState(local)).pending).toBeNull();
  });

  test("clears grant on unauthorized and clears pending on recovery conflict", async () => {
    for (const [code, expectedGrant] of [
      ["CLIPPER_UNAUTHORIZED", null],
      ["CLIPPER_IDEMPOTENCY_RECOVERY_CONFLICT", grant],
    ] as const) {
      const local = new MemoryStorage();
      const session = new MemoryStorage();
      await writeClipperState(
        {
          gatewayOrigin: "http://127.0.0.1:3000",
          grant: { ...grant, expiresAt: "2099-08-24T08:00:00.000Z" },
          pending: null,
        },
        local
      );
      const controller = makeController(local, session, (() =>
        Promise.resolve(
          jsonResponse(
            { error: { code, message: code } },
            code === "CLIPPER_UNAUTHORIZED" ? 401 : 409
          )
        )) as unknown as typeof fetch);
      const captureError = await controller
        .capture(payload, "4".repeat(64))
        .catch((error: unknown) => error);
      expect(captureError).toMatchObject({ code });
      const state = await readClipperState(local);
      expect(state.pending).toBeNull();
      expect(state.grant).toEqual(
        expectedGrant === null
          ? null
          : { ...grant, expiresAt: "2099-08-24T08:00:00.000Z" }
      );
    }
  });
});
