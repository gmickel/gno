import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../../../src/mcp/server";
import type { DocumentRow } from "../../../src/store/types";

import { handleRenameNote } from "../../../src/mcp/tools/workspace-write";
import { safeRm } from "../../helpers/cleanup";

const logicalRecord = (): DocumentRow => ({
  id: 1,
  collection: "exports",
  relPath: `.gno/records/container/${"a".repeat(64)}.md`,
  sourceHash: "a".repeat(64),
  sourceMime: "text/vtt",
  sourceExt: ".vtt",
  sourceSize: 120,
  sourceMtime: "2026-07-25T08:00:00.000Z",
  docid: "#record1",
  uri: `gno://exports/.gno/records/container/${"a".repeat(64)}.md`,
  title: "Ada at 00:01",
  mirrorHash: "mirror-record",
  converterId: "adapter/transcript",
  converterVersion: "1.0.0",
  languageHint: "en",
  recordKey: "a".repeat(64),
  recordSourcePath: "meeting.vtt",
  recordSourceLocator: "lines:1-3",
  recordAdapterFingerprint: "b".repeat(64),
  lastErrorCode: null,
  lastErrorMessage: null,
  lastErrorAt: null,
  active: true,
  ingestVersion: 1,
  createdAt: "2026-07-25T08:00:00.000Z",
  updatedAt: "2026-07-25T08:00:00.000Z",
});

describe("workspace write logical export records", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-mcp-export-record-"));
  });

  afterEach(async () => {
    await safeRm(root);
  });

  test("rejects refactors before attempting to rename a virtual path", async () => {
    const doc = logicalRecord();
    const context = {
      store: {
        getDocumentByUri: (uri: string) =>
          Promise.resolve({
            ok: true as const,
            value: uri === doc.uri ? doc : null,
          }),
      },
      config: {
        version: "1.0",
        ftsTokenizer: "unicode61",
        collections: [
          {
            name: "exports",
            path: root,
            pattern: "**/*",
            include: [],
            exclude: [],
          },
        ],
        contexts: [],
      },
      collections: [
        {
          name: "exports",
          path: root,
          pattern: "**/*",
          include: [],
          exclude: [],
        },
      ],
      actualConfigPath: join(root, "config.yml"),
      indexName: "default",
      toolMutex: { acquire: async () => () => undefined },
      jobManager: {},
      serverInstanceId: "test",
      writeLockPath: join(root, ".write.lock"),
      enableWrite: true,
      isShuttingDown: () => false,
    } as unknown as ToolContext;

    const result = await handleRenameNote(
      {
        action: "preview",
        ref: doc.uri,
        name: "renamed.vtt",
      },
      context
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: "CONFLICT",
      message: expect.stringContaining("logical record"),
    });
  });
});
