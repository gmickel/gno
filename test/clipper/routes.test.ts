import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises structure operations have no Bun equivalent.
import { mkdtemp, mkdir } from "node:fs/promises";
// node:os has no Bun temp-directory helper.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { HttpMcpPeerServer } from "../../src/mcp/http-security";
import type { ContextHolder } from "../../src/serve/routes/api";

import {
  clipperRoutesForBind,
  createClipperRouteGateway,
} from "../../src/serve/routes/clipper";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
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

const headers = (
  origin: string,
  extras: Record<string, string> = {}
): HeadersInit => ({
  Host: "127.0.0.1:3000",
  Origin: origin,
  ...extras,
});

describe("browser clipper route gateway", () => {
  let tempDir: string;
  let store: SqliteAdapter;
  let context: ContextHolder;
  let routes: ReturnType<typeof createClipperRouteGateway>["routes"];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gno-clipper-routes-"));
    await mkdir(join(tempDir, "notes", "clips"), { recursive: true });
    await Bun.write(
      join(tempDir, "notes", "clips", "article.md"),
      "# Existing without browser provenance\n"
    );
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
    routes = createClipperRouteGateway(context, store, {
      host: "127.0.0.1",
      port: 3000,
    }).routes;
  });

  afterEach(async () => {
    await store.close();
    await safeRm(tempDir);
  });

  test("pairs once, previews, writes a conflict, replays, and revokes", async () => {
    const start = await routes["/api/clipper/pair/start"]?.POST?.(
      new Request(`${LISTENER_ORIGIN}/api/clipper/pair/start`, {
        method: "POST",
        headers: headers(EXTENSION_ORIGIN),
      }),
      server
    );
    expect(start?.status).toBe(200);
    const started = (await start?.json()) as {
      pairId: string;
      pairingCode: string;
    };
    expect(started.pairId).toMatch(/^[a-f0-9]{64}$/);
    expect(assertValid(started, await loadSchema("clipper-pair-start"))).toBe(
      true
    );

    const csrf = await routes["/api/clipper/pair/csrf"]?.GET?.(
      new Request(`${LISTENER_ORIGIN}/api/clipper/pair/csrf`, {
        headers: headers(LISTENER_ORIGIN),
      }),
      server
    );
    const csrfBody = (await csrf?.json()) as { csrfToken: string };
    expect(assertValid(csrfBody, await loadSchema("clipper-csrf"))).toBe(true);
    const rejectedApproval = await routes["/api/clipper/pair/approve"]?.POST?.(
      new Request(`${LISTENER_ORIGIN}/api/clipper/pair/approve`, {
        method: "POST",
        headers: headers(LISTENER_ORIGIN, {
          "Content-Type": "application/json",
          "X-GNO-CSRF": "wrong",
        }),
        body: JSON.stringify({
          pairId: started.pairId,
          pairingCode: started.pairingCode,
        }),
      }),
      server
    );
    expect(rejectedApproval?.status).toBe(403);
    expect(
      assertValid(
        await rejectedApproval?.json(),
        await loadSchema("clipper-error")
      )
    ).toBe(true);
    const approval = await routes["/api/clipper/pair/approve"]?.POST?.(
      new Request(`${LISTENER_ORIGIN}/api/clipper/pair/approve`, {
        method: "POST",
        headers: headers(LISTENER_ORIGIN, {
          "Content-Type": "application/json",
          "X-GNO-CSRF": csrfBody.csrfToken,
        }),
        body: JSON.stringify({
          pairId: started.pairId,
          pairingCode: started.pairingCode,
        }),
      }),
      server
    );
    expect(approval?.status).toBe(200);
    expect(
      assertValid(
        await approval?.json(),
        await loadSchema("clipper-pair-approval")
      )
    ).toBe(true);

    const pollRoute = routes["/api/clipper/pair/:pairId"]?.GET;
    const poll = await pollRoute?.(
      new Request(`${LISTENER_ORIGIN}/api/clipper/pair/${started.pairId}`, {
        headers: headers(EXTENSION_ORIGIN),
      }),
      server
    );
    expect(poll?.status).toBe(200);
    const grant = (await poll?.json()) as {
      grantId: string;
      grantToken: string;
      status: string;
    };
    expect(grant.status).toBe("approved");
    expect(grant.grantToken).toMatch(/^[a-f0-9]{64}$/);
    expect(assertValid(grant, await loadSchema("clipper-pair-status"))).toBe(
      true
    );

    const replayedPoll = await pollRoute?.(
      new Request(`${LISTENER_ORIGIN}/api/clipper/pair/${started.pairId}`, {
        headers: headers(EXTENSION_ORIGIN),
      }),
      server
    );
    expect(replayedPoll?.status).toBe(410);
    expect(await replayedPoll?.json()).toEqual({
      schemaVersion: "1.0",
      status: "consumed",
    });

    const authorization = { Authorization: `Bearer ${grant.grantToken}` };
    const preview = await routes["/api/capture/clip/preview"]?.POST?.(
      new Request(`${LISTENER_ORIGIN}/api/capture/clip/preview`, {
        method: "POST",
        headers: headers(EXTENSION_ORIGIN, {
          ...authorization,
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(clipPayload()),
      }),
      server
    );
    expect(preview?.status).toBe(200);
    const previewBody = (await preview?.json()) as {
      preview: { digest: string };
      plan: { outcome: string; provenanceConflict: boolean };
    };
    expect(previewBody.plan).toMatchObject({
      outcome: "conflict",
      provenanceConflict: true,
    });
    expect(
      await Bun.file(join(tempDir, "notes", "clips", "article.md")).text()
    ).toBe("# Existing without browser provenance\n");
    expect(
      assertValid(previewBody, await loadSchema("browser-clip-preview"))
    ).toBe(true);

    const captureBody = JSON.stringify({
      payload: clipPayload(),
      previewDigest: previewBody.preview.digest,
    });
    const captureRequest = () =>
      new Request(`${LISTENER_ORIGIN}/api/capture/clip`, {
        method: "POST",
        headers: headers(EXTENSION_ORIGIN, {
          ...authorization,
          "Content-Type": "application/json",
          "Idempotency-Key": "one-logical-write",
        }),
        body: captureBody,
      });
    const captured = await routes["/api/capture/clip"]?.POST?.(
      captureRequest(),
      server
    );
    expect(captured?.status).toBe(409);
    const receipt = (await captured?.json()) as {
      collisionPolicyResult: string;
    };
    expect(receipt.collisionPolicyResult).toBe("conflict");
    expect(assertValid(receipt, await loadSchema("capture-receipt"))).toBe(
      true
    );

    const replay = await routes["/api/capture/clip"]?.POST?.(
      captureRequest(),
      server
    );
    expect(replay?.status).toBe(409);
    expect(replay?.headers.get("Idempotent-Replay")).toBe("true");
    expect(await replay?.json()).toEqual(receipt);

    const createdPayload = {
      ...clipPayload(),
      destination: {
        ...clipPayload().destination,
        relPath: "clips/new-article.md",
        collisionPolicy: "error",
      },
    };
    const createdPreview = await routes["/api/capture/clip/preview"]?.POST?.(
      new Request(`${LISTENER_ORIGIN}/api/capture/clip/preview`, {
        method: "POST",
        headers: headers(EXTENSION_ORIGIN, {
          ...authorization,
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(createdPayload),
      }),
      server
    );
    const createdPreviewBody = (await createdPreview?.json()) as {
      preview: { digest: string };
    };
    const createdRequest = () =>
      new Request(`${LISTENER_ORIGIN}/api/capture/clip`, {
        method: "POST",
        headers: headers(EXTENSION_ORIGIN, {
          ...authorization,
          "Content-Type": "application/json",
          "Idempotency-Key": "successful-logical-write",
        }),
        body: JSON.stringify({
          payload: createdPayload,
          previewDigest: createdPreviewBody.preview.digest,
        }),
      });
    const created = await routes["/api/capture/clip"]?.POST?.(
      createdRequest(),
      server
    );
    expect(created?.status).toBe(202);
    const createdReceipt = await created?.json();
    const createdReplay = await routes["/api/capture/clip"]?.POST?.(
      createdRequest(),
      server
    );
    expect(createdReplay?.status).toBe(202);
    expect(createdReplay?.headers.get("Idempotent-Replay")).toBe("true");
    expect(await createdReplay?.json()).toEqual(createdReceipt);
    routes = createClipperRouteGateway(context, store, {
      host: "127.0.0.1",
      port: 3000,
    }).routes;
    const restartedReplay = await routes["/api/capture/clip"]?.POST?.(
      createdRequest(),
      server
    );
    expect(restartedReplay?.status).toBe(202);
    expect(restartedReplay?.headers.get("Idempotent-Replay")).toBe("true");
    expect(await restartedReplay?.json()).toEqual(createdReceipt);
    await Bun.sleep(25);

    const revoked = await routes["/api/clipper/revoke"]?.POST?.(
      new Request(`${LISTENER_ORIGIN}/api/clipper/revoke`, {
        method: "POST",
        headers: headers(EXTENSION_ORIGIN, authorization),
      }),
      server
    );
    expect(revoked?.status).toBe(200);
    const revokedBody = await revoked?.json();
    expect(revokedBody).toMatchObject({
      grantId: grant.grantId,
      status: "revoked",
    });
    expect(assertValid(revokedBody, await loadSchema("clipper-revoke"))).toBe(
      true
    );

    const denied = await routes["/api/capture/clip/preview"]?.POST?.(
      new Request(`${LISTENER_ORIGIN}/api/capture/clip/preview`, {
        method: "POST",
        headers: headers(EXTENSION_ORIGIN, {
          ...authorization,
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(clipPayload()),
      }),
      server
    );
    expect(denied?.status).toBe(401);
  });

  test("omits routes off loopback and rejects foreign origins and bearers", async () => {
    expect(clipperRoutesForBind(false, { routes })).toEqual({});
    expect(clipperRoutesForBind(true, { routes })).toBe(routes);

    const foreignOrigin = await routes["/api/clipper/pair/start"]?.POST?.(
      new Request(`${LISTENER_ORIGIN}/api/clipper/pair/start`, {
        method: "POST",
        headers: headers("https://attacker.example"),
      }),
      server
    );
    expect(foreignOrigin?.status).toBe(403);

    const foreignBearer = await routes["/api/capture/clip/preview"]?.POST?.(
      new Request(`${LISTENER_ORIGIN}/api/capture/clip/preview`, {
        method: "POST",
        headers: headers(EXTENSION_ORIGIN, {
          Authorization: `Bearer ${"c".repeat(64)}`,
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(clipPayload()),
      }),
      server
    );
    expect(foreignBearer?.status).toBe(401);

    expect(() =>
      createClipperRouteGateway(context, store, {
        host: "::1",
        port: 3000,
      })
    ).not.toThrow();
  });
});
