import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { DocumentInput } from "../../src/store/types";

import { createDefaultConfig } from "../../src/config";
import {
  listSavedCapsules,
  registerSavedCapsule,
} from "../../src/core/capsule-registry";
import { reverifySavedCapsuleManually } from "../../src/core/capsule-reverification";
import { SavedCapsuleReverificationScheduler } from "../../src/core/capsule-reverification-scheduler";
import { canonicalContextCapsuleJson } from "../../src/core/context-capsule";
import { SqliteAdapter } from "../../src/store";
import {
  capsuleFor,
  createVerifierStore,
  verifierFixture,
} from "../core/context-verifier-fixture";
import { safeRm } from "../helpers/cleanup";

const documentInput = (
  row: ReturnType<typeof verifierFixture>["first"]
): DocumentInput => ({
  collection: row.collection,
  relPath: row.relPath,
  sourceHash: row.sourceHash,
  sourceMime: row.sourceMime,
  sourceExt: row.sourceExt,
  sourceSize: row.sourceSize,
  sourceMtime: row.sourceMtime,
  mirrorHash: row.mirrorHash ?? undefined,
  title: row.title ?? undefined,
  changeJournal: { observedAtMs: Date.now() },
});

describe("saved Context Capsule reverification", () => {
  let adapter: SqliteAdapter;
  let testDir = "";
  let capsulePath = "";
  let config: Config;
  const fixture = verifierFixture(false);

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-saved-capsule-"));
    adapter = new SqliteAdapter();
    expect(
      (await adapter.open(join(testDir, "index-default.sqlite"), "unicode61"))
        .ok
    ).toBe(true);
    config = createDefaultConfig();
    config.collections = [
      {
        name: "notes",
        path: testDir,
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ];
    expect((await adapter.syncCollections(config.collections)).ok).toBe(true);
    expect((await adapter.syncContexts([])).ok).toBe(true);

    for (const row of fixture.state.documents) {
      expect((await adapter.upsertDocument(documentInput(row))).ok).toBe(true);
      const content = fixture.state.contents.get(row.mirrorHash ?? "") ?? "";
      expect(
        (await adapter.upsertContent(row.mirrorHash ?? "", content)).ok
      ).toBe(true);
      const chunks = fixture.state.chunks.get(row.mirrorHash ?? "") ?? [];
      expect(
        (
          await adapter.upsertChunks(
            row.mirrorHash ?? "",
            chunks.map((chunk) => ({
              seq: chunk.seq,
              pos: chunk.pos,
              text: chunk.text,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              language: chunk.language ?? undefined,
              tokenCount: chunk.tokenCount ?? undefined,
            }))
          )
        ).ok
      ).toBe(true);
    }

    const mock = createVerifierStore(fixture.state);
    const capsule = await capsuleFor(mock.store, fixture.state);
    capsulePath = join(testDir, "decision.capsule.json");
    await Bun.write(capsulePath, canonicalContextCapsuleJson(capsule));
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test("persists metadata and evidence references but never Capsule passage bytes", async () => {
    const before = await Bun.file(capsulePath).text();
    const registration = await registerSavedCapsule(adapter, "default", {
      filePath: capsulePath,
      question: "Who owns the decision?",
      label: "Decision owners",
      notificationPreference: "local",
    });

    expect(registration.indexName).toBe("default");
    expect(registration.evidence).toHaveLength(2);
    expect(await Bun.file(capsulePath).text()).toBe(before);
    const persisted = adapter
      .getRawDb()
      .query<{ registration: string; evidence: string }, []>(
        `SELECT
           (SELECT group_concat(file_path || capsule_id || COALESCE(question, ''))
            FROM saved_capsule_registrations) AS registration,
           (SELECT group_concat(
             evidence_id || canonical_uri || source_hash || mirror_hash || passage_hash
           ) FROM saved_capsule_evidence) AS evidence`
      )
      .get();
    expect(JSON.stringify(persisted)).not.toContain("Mina owns the decision");
    expect((await listSavedCapsules(adapter))[0]?.registrationId).toBe(
      registration.registrationId
    );
  });

  test("keeps completed receipts separate from index-mismatch operation failures", async () => {
    const registration = await registerSavedCapsule(adapter, "default", {
      filePath: capsulePath,
    });
    const readSpy = spyOn(adapter, "getDocumentsByDocids");
    const outcome = await reverifySavedCapsuleManually(
      registration.registrationId,
      {
        store: adapter,
        config,
        indexName: "another",
      }
    );

    expect(outcome.receipt).toBeNull();
    expect(outcome.verification).toMatchObject({
      operationStatus: "failed",
      affectedQuestionState: "unknown",
      receiptJson: null,
      errorCode: "invalid_filter",
    });
    expect(readSpy).not.toHaveBeenCalled();
  });

  test("coalesces journal changes and reverifies only referenced evidence", async () => {
    const registration = await registerSavedCapsule(adapter, "default", {
      filePath: capsulePath,
      notificationPreference: "local",
    });
    const unrelated = {
      ...fixture.first,
      id: 99,
      relPath: "unrelated.md",
      uri: "gno://notes/unrelated.md",
      sourceHash: "a".repeat(64),
      mirrorHash: "b".repeat(64),
    };
    expect((await adapter.upsertDocument(documentInput(unrelated))).ok).toBe(
      true
    );

    const notifications: unknown[] = [];
    const persistedBeforeNotification: string[] = [];
    const runSettled = async (): Promise<void> => {
      const work: Promise<void>[] = [];
      const scheduler = new SavedCapsuleReverificationScheduler({
        deps: {
          store: adapter,
          config,
          indexName: "default",
          notify: (event) => {
            const persisted = adapter
              .getRawDb()
              .query<{ operation_status: string }, [string]>(
                `SELECT operation_status FROM saved_capsule_verifications
                 WHERE registration_id = ?`
              )
              .get(event.registrationId);
            persistedBeforeNotification.push(
              persisted?.operation_status ?? "missing"
            );
            notifications.push(event);
          },
        },
        startBackgroundWork: (operation) => {
          work.push(operation(new AbortController().signal));
          return true;
        },
      });
      scheduler.notifySyncSettled();
      await Promise.all(work);
    };

    await runSettled();
    expect((await listSavedCapsules(adapter))[0]?.verification).toBeNull();

    const changed = {
      ...fixture.first,
      sourceHash: "c".repeat(64),
    };
    expect((await adapter.upsertDocument(documentInput(changed))).ok).toBe(
      true
    );
    await runSettled();

    const stored = (await listSavedCapsules(adapter))[0];
    expect(stored?.verification).toMatchObject({
      triggerKind: "journal",
      operationStatus: "completed",
      affectedQuestionState: "affected",
      affectedReasons: expect.arrayContaining(["content_stale"]),
    });
    expect(stored?.verification?.receiptJson).toContain('"source_stale"');
    expect(stored?.verification?.receiptJson).toContain(
      '"rankingCode":"ranking_unavailable"'
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      type: "capsule-reverified",
      registrationId: registration.registrationId,
      capsuleId: registration.capsuleId,
      operationStatus: "completed",
      affectedQuestionState: "affected",
      changedAt: expect.any(String),
    });
    expect(JSON.stringify(notifications)).not.toContain(capsulePath);
    expect(JSON.stringify(notifications)).not.toContain("Mina owns");
    expect(persistedBeforeNotification).toEqual(["completed"]);

    const verifiedAtMs = stored?.verification?.verifiedAtMs;
    await runSettled();
    expect(notifications).toHaveLength(1);
    expect(
      (await listSavedCapsules(adapter))[0]?.verification?.verifiedAtMs
    ).toBe(verifiedAtMs);
  });

  test("recovers conservatively when the persisted journal cursor expires", async () => {
    const registration = await registerSavedCapsule(adapter, "default", {
      filePath: capsulePath,
    });
    expect(
      (
        await adapter.upsertDocument(
          documentInput({
            ...fixture.first,
            sourceHash: "d".repeat(64),
          })
        )
      ).ok
    ).toBe(true);
    expect((await adapter.purgeDocumentChanges()).ok).toBe(true);

    const drains: Array<{ cursorExpired: boolean; affected: number }> = [];
    const work: Promise<void>[] = [];
    const scheduler = new SavedCapsuleReverificationScheduler({
      deps: { store: adapter, config, indexName: "default" },
      startBackgroundWork: (operation) => {
        work.push(operation(new AbortController().signal));
        return true;
      },
      onDrain: (result) => drains.push(result),
    });
    scheduler.notifySyncSettled();
    await Promise.all(work);

    expect(drains).toHaveLength(1);
    expect(drains[0]).toMatchObject({ cursorExpired: true, affected: 1 });
    expect((await listSavedCapsules(adapter))[0]?.verification).toMatchObject({
      registrationId: registration.registrationId,
      operationStatus: "completed",
      affectedQuestionState: "affected",
    });
  });

  test("reports a changed saved file without rewriting it", async () => {
    const registration = await registerSavedCapsule(adapter, "default", {
      filePath: capsulePath,
    });
    const changedBytes = `${await Bun.file(capsulePath).text()}\n`;
    await Bun.write(capsulePath, changedBytes);

    const outcome = await reverifySavedCapsuleManually(
      registration.registrationId,
      { store: adapter, config, indexName: "default" }
    );
    expect(outcome.verification).toMatchObject({
      operationStatus: "failed",
      errorCode: "capsule_file_changed",
      receiptJson: null,
    });
    expect(await Bun.file(capsulePath).text()).toBe(changedBytes);
  });
});
