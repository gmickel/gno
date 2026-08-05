/**
 * A browser clip aimed at a destination the indexer can never reach.
 *
 * `executeResidentCapturePlan` refuses BEFORE writing. The clipper route used
 * to let that refusal escape as an opaque `CLIPPER_CAPTURE_FAILED` 500 while
 * the idempotency claim it had just taken stayed `pending` forever - a claim
 * standing in for a write that never happened.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises structure/link operations have no Bun equivalent.
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
// node:os has no Bun temp-directory helper.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { HttpMcpPeerServer } from "../../src/mcp/http-security";
import type { ContextHolder } from "../../src/serve/routes/api";

import { createClipperRouteGateway } from "../../src/serve/routes/clipper";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const EXTENSION_ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const LISTENER_ORIGIN = "http://127.0.0.1:3000";
const IDEMPOTENCY_KEY = "one-refused-write";

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
    relPath: "clips/alias/article.md",
    folderPath: null,
    collisionPolicy: "error",
  },
  tags: ["web"],
  note: null,
  selection: { exactText: "Visible article body", editedMarkdown: null },
});

describe("browser clip into an unreachable destination", () => {
  let tempDir: string;
  let store: SqliteAdapter;
  let context: ContextHolder;
  let routes: ReturnType<typeof createClipperRouteGateway>["routes"];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gno-clipper-destination-"));
    await mkdir(join(tempDir, "notes", "clips", "real"), { recursive: true });
    // `clips/alias -> clips/real`: writable with `mkdir -p`, invisible to the
    // walker, so a clip written through it would never be indexed.
    await symlink(
      join(tempDir, "notes", "clips", "real"),
      join(tempDir, "notes", "clips", "alias")
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

  const pair = async (): Promise<string> => {
    const start = await routes["/api/clipper/pair/start"]?.POST?.(
      new Request(`${LISTENER_ORIGIN}/api/clipper/pair/start`, {
        method: "POST",
        headers: headers(EXTENSION_ORIGIN),
      }),
      server
    );
    const started = (await start?.json()) as {
      pairId: string;
      pairingCode: string;
    };
    const csrf = await routes["/api/clipper/pair/csrf"]?.GET?.(
      new Request(`${LISTENER_ORIGIN}/api/clipper/pair/csrf`, {
        headers: headers(LISTENER_ORIGIN),
      }),
      server
    );
    const csrfBody = (await csrf?.json()) as { csrfToken: string };
    await routes["/api/clipper/pair/approve"]?.POST?.(
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
    const poll = await routes["/api/clipper/pair/:pairId"]?.POST?.(
      new Request(`${LISTENER_ORIGIN}/api/clipper/pair/${started.pairId}`, {
        method: "POST",
        headers: headers(EXTENSION_ORIGIN),
      }),
      server
    );
    const grant = (await poll?.json()) as { grantToken: string };
    return grant.grantToken;
  };

  const previewThenCapture = async (
    token: string
  ): Promise<Response | undefined> => {
    const authorization = { Authorization: `Bearer ${token}` };
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
    };
    return await routes["/api/capture/clip"]?.POST?.(
      new Request(`${LISTENER_ORIGIN}/api/capture/clip`, {
        method: "POST",
        headers: headers(EXTENSION_ORIGIN, {
          ...authorization,
          "Content-Type": "application/json",
          "Idempotency-Key": IDEMPOTENCY_KEY,
        }),
        body: JSON.stringify({
          payload: clipPayload(),
          previewDigest: previewBody.preview.digest,
        }),
      }),
      server
    );
  };

  const claimRows = (): { state: string }[] =>
    store
      .getRawDb()
      .query<{ state: string }, []>(
        "SELECT state FROM clipper_capture_idempotency"
      )
      .all();

  test("reports the refusal structurally and leaves no claim behind", async () => {
    const token = await pair();

    const refused = await previewThenCapture(token);

    expect(refused?.status).toBe(409);
    const body = await refused?.json();
    expect(body).toEqual({
      error: {
        code: "VALIDATION",
        message: expect.stringContaining("clips/alias/article.md"),
        details: {
          reason: "PATH_NOT_WALKABLE",
          relPath: "clips/alias/article.md",
        },
      },
    });
    expect(assertValid(body, await loadSchema("clipper-error"))).toBe(true);
    // Refused BEFORE the write: nothing landed through the alias.
    expect(
      await Bun.file(
        join(tempDir, "notes", "clips", "real", "article.md")
      ).exists()
    ).toBe(false);
    // And no claim survives a request that wrote nothing - a `pending` row
    // here is a tombstone every later retry has to reconcile against.
    expect(claimRows()).toEqual([]);

    // Fix the destination and retry with the SAME key: the write proceeds.
    await rm(join(tempDir, "notes", "clips", "alias"));
    await mkdir(join(tempDir, "notes", "clips", "alias"), { recursive: true });

    const captured = await previewThenCapture(token);

    expect(captured?.status).toBe(202);
    expect(await captured?.json()).toMatchObject({
      relPath: "clips/alias/article.md",
      collisionPolicyResult: "created",
    });
    expect(
      await Bun.file(
        join(tempDir, "notes", "clips", "alias", "article.md")
      ).exists()
    ).toBe(true);
  });
});
