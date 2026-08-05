import { describe, expect, test } from "bun:test";

import type { LocalStorageArea } from "../src/storage";

import { payload } from "./fixtures";

class MemoryStorage implements LocalStorageArea {
  values: Record<string, unknown> = {};
  async get(): Promise<Record<string, unknown>> {
    return { ...this.values };
  }
  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, items);
  }
}

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void
) => boolean;

const EXTENSION_ID = "a".repeat(32);
const GATEWAY_ORIGIN = "http://127.0.0.1:3000";

const local = new MemoryStorage();
const listeners: MessageListener[] = [];

const destinationRefusal = () =>
  new Response(
    JSON.stringify({
      error: {
        code: "VALIDATION",
        message: "Refused a destination the indexer would never walk.",
        details: {
          reason: "PATH_NOT_WALKABLE",
          relPath: "clips/hidden/article.md",
        },
      },
    }),
    { status: 409, headers: { "Content-Type": "application/json" } }
  );

// The service worker reads these at import time, so the stub must exist first.
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { local, session: new MemoryStorage() },
  runtime: {
    id: EXTENSION_ID,
    onMessage: {
      addListener: (listener: MessageListener) => listeners.push(listener),
    },
  },
  tabs: {
    create: async () => undefined,
    query: async () => [],
    sendMessage: async () => ({ ok: false }),
  },
  scripting: { executeScript: async () => undefined },
};
globalThis.fetch = (async () =>
  destinationRefusal()) as unknown as typeof fetch;

const respond = async (message: unknown): Promise<unknown> => {
  await import("../src/service-worker");
  const listener = listeners[0];
  if (!listener) throw new Error("Service worker registered no listener");
  return await new Promise((resolve) => {
    listener(message, {}, resolve);
  });
};

describe("browser clipper service worker messaging", () => {
  test("forwards the structural refusal reason to extension code", async () => {
    const { writeClipperState } = await import("../src/storage");
    await writeClipperState(
      {
        gatewayOrigin: GATEWAY_ORIGIN,
        grant: {
          grantId: "123e4567-e89b-42d3-a456-426614174000",
          grantToken: "a".repeat(64),
          expiresAt: "2099-08-24T08:00:00.000Z",
        },
        pending: null,
      },
      local
    );

    const reply = (await respond({ type: "PREVIEW", payload })) as {
      ok: boolean;
      error: {
        code: string;
        message: string;
        details?: { reason: string; relPath: string };
      };
    };

    expect(reply.ok).toBeFalse();
    expect(reply.error.code).toBe("VALIDATION");
    // The point of the wiring: extension code can tell PATH_NOT_WALKABLE from
    // PATH_OUTSIDE_COLLECTION without parsing the prose message.
    expect(reply.error.details).toEqual({
      reason: "PATH_NOT_WALKABLE",
      relPath: "clips/hidden/article.md",
    });
  });

  test("omits details for errors that never carry them", async () => {
    const reply = (await respond({ type: "NOT_A_MESSAGE" })) as {
      ok: boolean;
      error: Record<string, unknown>;
    };

    expect(reply.ok).toBeFalse();
    expect(reply.error.code).toBe("CLIPPER_CLIENT");
    expect("details" in reply.error).toBeFalse();
  });
});
