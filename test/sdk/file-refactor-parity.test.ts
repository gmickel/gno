/**
 * SDK/MCP semantic parity for canonical rename/move preview+apply.
 *
 * Uses separate stores over identical on-disk note trees so digests and
 * terminal statuses can be compared without sharing a live SQLite handle.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises for mkdir/mkdtemp/cp (structure ops; no Bun equivalent)
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
// node:os tmpdir — no Bun equivalent
import { tmpdir } from "node:os";
// node:path join — no Bun equivalent
import { join } from "node:path";

import type { ToolContext } from "../../src/mcp/server";
import type { ContextHolder } from "../../src/serve/routes/api";

import { createDefaultConfig } from "../../src/config";
import {
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_SCHEMA_VERSION,
} from "../../src/core/file-refactors";
import { defaultSyncService } from "../../src/ingestion";
import {
  handleMoveNote,
  handleRenameNote,
} from "../../src/mcp/tools/workspace-write";
import { createGnoClient } from "../../src/sdk/client";
import {
  handleRefactorPlan,
  handleRenameDoc,
} from "../../src/serve/routes/api";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

async function seedNotes(notesPath: string): Promise<void> {
  await mkdir(notesPath, { recursive: true });
  await writeFile(join(notesPath, "alpha.md"), "# Alpha\n\nSee [[beta]].\n");
  await writeFile(join(notesPath, "beta.md"), "# Beta\n");
  await writeFile(join(notesPath, "gamma.md"), "# Gamma\n");
}

describe("SDK/MCP file-refactor surface parity", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-rf-parity-"));
  });

  afterEach(async () => {
    await safeRm(root);
  });

  test("preview digests match and apply statuses stay typed across surfaces", async () => {
    const sdkNotes = join(root, "sdk-notes");
    const mcpNotes = join(root, "mcp-notes");
    const restNotes = join(root, "rest-notes");
    await seedNotes(sdkNotes);
    await cp(sdkNotes, mcpNotes, { recursive: true });
    await cp(sdkNotes, restNotes, { recursive: true });

    const sdkConfig = createDefaultConfig();
    sdkConfig.collections = [
      {
        name: "notes",
        path: sdkNotes,
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ];
    const sdkClient = await createGnoClient({
      config: sdkConfig,
      dbPath: join(root, "sdk.db"),
    });
    await sdkClient.update();

    const sdkRenamePreview = await sdkClient.previewRenameNote({
      ref: "notes/beta.md",
      name: "beta-renamed.md",
    });
    const sdkMovePreview = await sdkClient.previewMoveNote({
      ref: "notes/gamma.md",
      folderPath: "archive",
    });
    expect(sdkRenamePreview.schemaVersion).toBe(FILE_REFACTOR_SCHEMA_VERSION);
    expect(sdkRenamePreview.canApply).toBe(true);
    expect(sdkMovePreview.canApply).toBe(true);

    const restConfig = createDefaultConfig();
    restConfig.collections = [
      {
        name: "notes",
        path: restNotes,
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ];
    const restStore = new SqliteAdapter();
    expect(
      (await restStore.open(join(root, "rest.db"), restConfig.ftsTokenizer)).ok
    ).toBe(true);
    expect((await restStore.syncCollections(restConfig.collections)).ok).toBe(
      true
    );
    await defaultSyncService.syncCollection(
      restConfig.collections[0]!,
      restStore,
      { runUpdateCmd: false }
    );
    const restDoc = await restStore.getDocument("notes", "beta.md");
    expect(restDoc.ok && restDoc.value).toBeTruthy();
    if (!restDoc.ok || !restDoc.value) return;
    const restCtx = {
      current: { config: restConfig },
      config: restConfig,
      scheduler: null,
      eventBus: null,
      watchService: null,
    } as unknown as ContextHolder;
    const restPreviewResponse = await handleRefactorPlan(
      restCtx,
      restStore,
      restDoc.value.docid,
      new Request("http://localhost/api/docs/beta/refactor-plan", {
        method: "POST",
        body: JSON.stringify({
          operation: "rename",
          name: "beta-renamed.md",
          uri: restDoc.value.uri,
        }),
      })
    );
    expect(restPreviewResponse.status).toBe(200);
    const restRenamePreview = (await restPreviewResponse.json()) as {
      planDigest: string;
      canApply: boolean;
    };
    expect(restRenamePreview.planDigest).toBe(sdkRenamePreview.planDigest);
    expect(restRenamePreview.canApply).toBe(true);

    const mcpConfig = createDefaultConfig();
    mcpConfig.collections = [
      {
        name: "notes",
        path: mcpNotes,
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ];
    const store = new SqliteAdapter();
    const opened = await store.open(
      join(root, "mcp.db"),
      mcpConfig.ftsTokenizer
    );
    expect(opened.ok).toBe(true);
    const synced = await store.syncCollections(mcpConfig.collections);
    expect(synced.ok).toBe(true);
    await defaultSyncService.syncCollection(mcpConfig.collections[0]!, store, {
      runUpdateCmd: false,
    });

    const mcpCtx = {
      store,
      config: mcpConfig,
      collections: mcpConfig.collections,
      actualConfigPath: join(root, "config.yml"),
      indexName: "default",
      toolMutex: { acquire: async () => () => undefined },
      jobManager: {},
      serverInstanceId: "parity",
      writeLockPath: join(root, ".write.lock"),
      enableWrite: true,
      isShuttingDown: () => false,
      markContentMutation: () => undefined,
    } as unknown as ToolContext;

    const mcpRenamePreviewResult = await handleRenameNote(
      {
        action: "preview",
        ref: "notes/beta.md",
        name: "beta-renamed.md",
      },
      mcpCtx
    );
    expect(mcpRenamePreviewResult.isError).toBeFalsy();
    const mcpRenamePreview = mcpRenamePreviewResult.structuredContent as {
      planDigest: string;
      canApply: boolean;
      examinedReferences: unknown[];
    };
    expect(mcpRenamePreview.planDigest).toBe(sdkRenamePreview.planDigest);
    expect(mcpRenamePreview.canApply).toBe(true);
    expect(Array.isArray(mcpRenamePreview.examinedReferences)).toBe(true);

    const mcpMovePreviewResult = await handleMoveNote(
      {
        action: "preview",
        ref: "notes/gamma.md",
        folderPath: "archive",
      },
      mcpCtx
    );
    expect(mcpMovePreviewResult.isError).toBeFalsy();
    expect(
      (mcpMovePreviewResult.structuredContent as { planDigest: string })
        .planDigest
    ).toBe(sdkMovePreview.planDigest);

    const sdkRename = await sdkClient.renameNote({
      ref: "notes/beta.md",
      name: "beta-renamed.md",
      schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      planDigest: sdkRenamePreview.planDigest,
      confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
    });
    expect(sdkRename.status).toBe("applied");

    const mcpRenameApply = await handleRenameNote(
      {
        action: "apply",
        ref: "notes/beta.md",
        name: "beta-renamed.md",
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: mcpRenamePreview.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        confirm: true,
      },
      mcpCtx
    );
    expect(mcpRenameApply.isError).toBeFalsy();
    expect(
      (mcpRenameApply.structuredContent as { status: string }).status
    ).toBe("applied");

    const restRenameApply = await handleRenameDoc(
      restCtx,
      restStore,
      restDoc.value.docid,
      new Request("http://localhost/api/docs/beta/rename", {
        method: "POST",
        body: JSON.stringify({
          name: "beta-renamed.md",
          uri: restDoc.value.uri,
          schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
          planDigest: restRenamePreview.planDigest,
          confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        }),
      })
    );
    expect(restRenameApply.status).toBe(200);
    expect(((await restRenameApply.json()) as { status: string }).status).toBe(
      "applied"
    );

    const sdkMove = await sdkClient.moveNote({
      ref: "notes/gamma.md",
      folderPath: "archive",
      schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      planDigest: sdkMovePreview.planDigest,
      confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
    });
    expect(sdkMove.status).toBe("applied");

    const mcpMoveApply = await handleMoveNote(
      {
        action: "apply",
        ref: "notes/gamma.md",
        folderPath: "archive",
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: sdkMovePreview.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        confirm: true,
      },
      mcpCtx
    );
    expect(mcpMoveApply.isError).toBeFalsy();
    expect((mcpMoveApply.structuredContent as { status: string }).status).toBe(
      "applied"
    );

    const stale = await handleRenameNote(
      {
        action: "apply",
        ref: "notes/alpha.md",
        name: "alpha-x.md",
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: "0".repeat(64),
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        confirm: true,
      },
      mcpCtx
    );
    expect(stale.isError).toBeFalsy();
    expect((stale.structuredContent as { status: string }).status).toBe(
      "stale_plan"
    );

    const restAlpha = await restStore.getDocument("notes", "alpha.md");
    expect(restAlpha.ok && restAlpha.value).toBeTruthy();
    if (!restAlpha.ok || !restAlpha.value) return;
    const restStale = await handleRenameDoc(
      restCtx,
      restStore,
      restAlpha.value.docid,
      new Request("http://localhost/api/docs/alpha/rename", {
        method: "POST",
        body: JSON.stringify({
          name: "alpha-x.md",
          schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
          planDigest: "0".repeat(64),
          confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        }),
      })
    );
    expect(restStale.status).toBe(409);
    expect(
      ((await restStale.json()) as { error: { details: { status: string } } })
        .error.details.status
    ).toBe("stale_plan");

    await sdkClient.close();
    await store.close();
    await restStore.close();
  });
});
