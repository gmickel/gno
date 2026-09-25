/**
 * Contract tests for request IDs: a write carrying `requestId` returns the
 * `request` object inside its shared schema (capture-receipt, memory-remember),
 * and the lookup validates against request-status.schema.json. Instances come
 * from the real SDK against a temp index (lexical-only, offline).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for mkdtemp/mkdir)
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { GnoClient } from "../../../src/sdk";

import { createDefaultConfig } from "../../../src/config/defaults";
import { createGnoClient } from "../../../src/sdk";
import { safeRm } from "../../helpers/cleanup";
import { assertValid, loadSchema } from "./validator";

const CAPTURE_ID = "contract-capture-1";
const REMEMBER_ID = "contract-remember-1";

describe("request IDs (SDK, temp index)", () => {
  let root: string;
  let client: GnoClient;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-request-status-contract-"));
    await mkdir(join(root, "notes"), { recursive: true });
    await mkdir(join(root, "memory"), { recursive: true });
    const config = {
      ...createDefaultConfig(),
      collections: [
        {
          name: "notes",
          path: join(root, "notes"),
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
        {
          name: "memory",
          path: join(root, "memory"),
          pattern: "**/*.md",
          include: [],
          exclude: [],
          memoryManaged: true,
        },
      ],
    };
    client = await createGnoClient({
      config,
      dbPath: join(root, "index.sqlite"),
      cacheDir: join(root, "cache"),
      downloadPolicy: { offline: true, allowDownload: false },
    });
  });

  afterAll(async () => {
    await client?.close();
    await safeRm(root);
  });

  test("capture with requestId validates against capture-receipt", async () => {
    const schema = await loadSchema("capture-receipt");
    const receipt = await client.capture({
      collection: "notes",
      title: "Request contract",
      content: "Captured once under a request ID.",
      requestId: CAPTURE_ID,
    });
    expect(receipt.request).toMatchObject({
      requestId: CAPTURE_ID,
      status: "committed",
      replayed: false,
    });
    expect(assertValid(receipt, schema)).toBe(true);
  });

  test("remember with requestId validates against memory-remember", async () => {
    const schema = await loadSchema("memory-remember");
    const result = await client.remember({
      text: "Release trains leave on Fridays.",
      collection: "memory",
      scopes: ["project:gno"],
      caller: "contract",
      session: "session-1",
      decision: "add",
      requestId: REMEMBER_ID,
    });
    expect(result).toMatchObject({
      outcome: "added",
      request: { requestId: REMEMBER_ID, replayed: false },
    });
    expect(assertValid(result, schema)).toBe(true);
  });

  test("committed and not_found lookups validate against request-status", async () => {
    const schema = await loadSchema("request-status");
    const committed = await client.requestStatus(CAPTURE_ID);
    expect(committed).toMatchObject({
      requestId: CAPTURE_ID,
      status: "committed",
      operation: "capture",
    });
    expect(assertValid(committed, schema)).toBe(true);

    const missing = await client.requestStatus("never-sent-1");
    expect(missing).toEqual({ requestId: "never-sent-1", status: "not_found" });
    expect(assertValid(missing, schema)).toBe(true);
  });
});
