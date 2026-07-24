import { describe, expect, test } from "bun:test";

import type { LocalStorageArea } from "../src/storage";

import {
  CLIPPER_STORAGE_KEY,
  clearGrant,
  readClipperState,
  writeClipperState,
} from "../src/storage";
import { grant, payload } from "./fixtures";

class MemoryStorage implements LocalStorageArea {
  values: Record<string, unknown> = {};

  async get(): Promise<Record<string, unknown>> {
    return { ...this.values };
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, items);
  }
}

describe("browser clipper local state", () => {
  test("persists only the gateway grant and one pending logical write", async () => {
    const storage = new MemoryStorage();
    await writeClipperState(
      {
        gatewayOrigin: "http://127.0.0.1:3000",
        grant,
        pending: {
          payload,
          previewDigest: "4".repeat(64),
          idempotencyKey: "same-logical-write",
        },
      },
      storage
    );

    const persisted = storage.values[CLIPPER_STORAGE_KEY];
    expect(JSON.stringify(await readClipperState(storage))).toBe(
      JSON.stringify(persisted)
    );
    expect(JSON.stringify(storage.values)).not.toContain("pairingCode");
    expect(JSON.stringify(storage.values)).not.toContain("pairId");

    await clearGrant(storage);
    expect(await readClipperState(storage)).toEqual({
      gatewayOrigin: "http://127.0.0.1:3000",
      grant: null,
      pending: null,
    });
  });

  test("fails closed for remote, corrupt, or unknown stored state", async () => {
    const storage = new MemoryStorage();
    storage.values[CLIPPER_STORAGE_KEY] = {
      gatewayOrigin: "https://remote.example",
      grant,
      pending: null,
      surprise: true,
    };
    expect(await readClipperState(storage)).toEqual({
      gatewayOrigin: null,
      grant: null,
      pending: null,
    });
    const invalidWrite = await writeClipperState(
      {
        gatewayOrigin: "http://localhost:3000",
        grant,
        pending: null,
      },
      storage
    ).catch((error: unknown) => error);
    expect(invalidWrite).toBeInstanceOf(Error);
    expect((invalidWrite as Error).message).toContain(
      "invalid browser clipper state"
    );
  });
});
