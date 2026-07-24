import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises structure operations have no Bun equivalent.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os has no Bun temp-directory helper.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { HttpMcpPeerServer } from "../../src/mcp/http-security";
import type { ContextHolder } from "../../src/serve/routes/api";

import { prepareBrowserClip } from "../../src/core/browser-clip";
import { writeCapturePlanFile } from "../../src/core/capture-write";
import {
  browserClipIdempotencyPlan,
  planResidentCapture,
} from "../../src/serve/capture-service";
import { clipperSha256 } from "../../src/serve/clipper-contract";
import { createClipperRouteGateway } from "../../src/serve/routes/clipper";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import {
  claimClipperIdempotency,
  createClipperGrant,
} from "../../src/store/sqlite/clipper-store";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const EXTENSION_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const LISTENER_ORIGIN = "http://127.0.0.1:3000";

const clipPayload = () => ({
  schemaVersion: "1.0",
  mode: "selection",
  sourceUrl: "https://example.com/article",
  canonicalUrl: null,
  title: "Captured article",
  author: null,
  site: "Example",
  publishedAt: null,
  observedAt: "2026-07-24T10:00:00.000Z",
  browser: { name: "Chromium", version: "140", platform: "macOS" },
  extraction: {
    visibility: "user_visible",
    authenticated: false,
    extractorVersion: "1.0.0",
    warnings: [],
  },
  destination: {
    collection: "notes",
    relPath: "clips/article.md",
    folderPath: null,
    collisionPolicy: "open_existing",
  },
  tags: ["web"],
  note: null,
  selection: { exactText: "Visible article body", editedMarkdown: null },
});

const server: HttpMcpPeerServer = {
  requestIP: () => ({ address: "127.0.0.1", port: 49_152 }),
  timeout: () => {},
};

const extensionHeaders = (
  extras: Record<string, string> = {}
): HeadersInit => ({
  Host: "127.0.0.1:3000",
  Origin: EXTENSION_ORIGIN,
  ...extras,
});

describe("browser clipper recovery", () => {
  let tempDir: string;
  let store: SqliteAdapter;
  let context: ContextHolder;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gno-clipper-recovery-"));
    await mkdir(join(tempDir, "notes", "clips"), { recursive: true });
    store = new SqliteAdapter();
    const opened = await store.open(join(tempDir, "index.sqlite"), "unicode61");
    if (!opened.ok) throw new Error(opened.error.message);
    const config: Config = {
      version: "1.0",
      ftsTokenizer: "unicode61",
      collections: [
        {
          name: "notes",
          path: join(tempDir, "notes"),
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
      contexts: [],
    };
    context = {
      current: { config } as ContextHolder["current"],
      config,
      scheduler: null,
      eventBus: null,
      watchService: null,
    };
  });

  afterEach(async () => {
    await store.close();
    await safeRm(tempDir);
  });

  test("recovers a write completed before receipt persistence without duplicating it", async () => {
    const token = "d".repeat(64);
    const nowMs = Date.now();
    const grant = createClipperGrant(store.getRawDb(), {
      id: "crash-recovery-grant",
      tokenHash: clipperSha256(token),
      origin: EXTENSION_ORIGIN,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + 60_000,
    });
    expect(grant.status).toBe("created");

    const payload = {
      ...clipPayload(),
      destination: {
        ...clipPayload().destination,
        relPath: "clips/recovered.md",
        collisionPolicy: "create_with_suffix" as const,
      },
    };
    const prepared = prepareBrowserClip(payload, {
      now: new Date("2026-07-24T08:00:00.000Z"),
    });
    const planned = await planResidentCapture(
      context,
      store,
      prepared.captureInput
    );
    if (!planned.ok) throw new Error(planned.message);
    const payloadDigest = clipperSha256(JSON.stringify(prepared.payload));
    const requestDigest = clipperSha256(
      `${prepared.preview.digest}\0${payloadDigest}`
    );
    expect(
      claimClipperIdempotency(store.getRawDb(), {
        grantId: "crash-recovery-grant",
        keyHash: clipperSha256("original-key"),
        requestDigest,
        plan: browserClipIdempotencyPlan(planned),
        nowMs,
      }).status
    ).toBe("claimed");

    await writeCapturePlanFile(planned.plan, planned.fullPath);
    const writtenContent = await Bun.file(planned.fullPath).text();
    const routes = createClipperRouteGateway(context, store, {
      host: "127.0.0.1",
      port: 3000,
    }).routes;
    const request = (idempotencyKey: string) =>
      new Request(`${LISTENER_ORIGIN}/api/capture/clip`, {
        method: "POST",
        headers: extensionHeaders({
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        }),
        body: JSON.stringify({
          payload,
          previewDigest: prepared.preview.digest,
        }),
      });

    await Bun.write(
      planned.fullPath,
      `${writtenContent.trimEnd()}\n\nTampered article body\n`
    );
    const rejectedDrift = await routes["/api/capture/clip"]?.POST?.(
      request("retry-with-new-key"),
      server
    );
    expect(rejectedDrift?.status).toBe(409);
    expect(await rejectedDrift?.json()).toMatchObject({
      error: { code: "CLIPPER_IDEMPOTENCY_RECOVERY_CONFLICT" },
    });
    await Bun.write(planned.fullPath, writtenContent);

    const recovered = await routes["/api/capture/clip"]?.POST?.(
      request("retry-with-new-key"),
      server
    );
    expect(recovered?.status).toBe(202);
    const receipt = await recovered?.json();
    expect(receipt).toMatchObject({
      relPath: "clips/recovered.md",
      collisionPolicyResult: "created",
      source: { capturedAt: "2026-07-24T08:00:00.000Z" },
      sync: { status: "skipped" },
    });
    expect(assertValid(receipt, await loadSchema("capture-receipt"))).toBe(
      true
    );

    const replay = await routes["/api/capture/clip"]?.POST?.(
      request("another-retry-key"),
      server
    );
    expect(replay?.status).toBe(202);
    expect(replay?.headers.get("Idempotent-Replay")).toBe("true");
    expect(await replay?.json()).toEqual(receipt);
    expect(
      await Bun.file(join(tempDir, "notes", "clips", "recovered-2.md")).exists()
    ).toBe(false);
  });

  test("classifies capture-store failures as runtime errors", async () => {
    const failingStore = {
      listDocuments: async () => ({
        ok: false as const,
        error: { message: "database unavailable" },
      }),
    } as unknown as SqliteAdapter;
    const result = await planResidentCapture(
      context,
      failingStore,
      prepareBrowserClip(clipPayload()).captureInput
    );
    expect(result).toEqual({
      ok: false,
      code: "RUNTIME",
      message: "database unavailable",
      status: 500,
    });
  });
});
