import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { ContextCapsuleV1 } from "../../src/core/context-capsule";
import type { DocumentInput } from "../../src/store/types";

import { createDefaultConfig } from "../../src/config";
import {
  listSavedCapsules,
  registerSavedCapsule,
} from "../../src/core/capsule-registry";
import { reverifySavedCapsuleManually } from "../../src/core/capsule-reverification";
import { SavedCapsuleReverificationScheduler } from "../../src/core/capsule-reverification-scheduler";
import { decodeDocumentChangeCursor } from "../../src/core/change-journal";
import {
  canonicalContextCapsuleJson,
  createContextCapsuleV1,
} from "../../src/core/context-capsule";
import { sha256Text } from "../../src/core/context-capsule-validation";
import { SqliteAdapter } from "../../src/store";
import {
  capsuleFor,
  createVerifierStore,
  documentRow,
  makeChunk,
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
  let capsule: ContextCapsuleV1;
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
    capsule = await capsuleFor(mock.store, fixture.state);
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

  test("queues a registration when the scheduler advances while its Capsule file loads", async () => {
    const before = await Bun.file(capsulePath).text();
    const notifications: unknown[] = [];
    const scheduler = new SavedCapsuleReverificationScheduler({
      deps: {
        store: adapter,
        config,
        indexName: "default",
        notify: (event) => notifications.push(event),
      },
      startBackgroundWork: () => false,
    });
    const originalGet = adapter.getSavedCapsuleRegistration.bind(adapter);
    let advancedBeforePersistence = false;
    const getSpy = spyOn(
      adapter,
      "getSavedCapsuleRegistration"
    ).mockImplementation(async (registrationId) => {
      if (!advancedBeforePersistence) {
        advancedBeforePersistence = true;
        expect(
          (
            await adapter.upsertDocument(
              documentInput({
                ...fixture.first,
                sourceHash: "9".repeat(64),
              })
            )
          ).ok
        ).toBe(true);
        const emptyDrain = await scheduler.triggerNow();
        expect(emptyDrain).toHaveLength(1);
        expect(emptyDrain[0]).toMatchObject({ affected: 0 });
      }
      return originalGet(registrationId);
    });

    const registration = await registerSavedCapsule(adapter, "default", {
      filePath: capsulePath,
      notificationPreference: "local",
    });
    getSpy.mockRestore();
    expect(advancedBeforePersistence).toBe(true);
    expect(await adapter.getSavedCapsuleReverificationSequence()).toEqual({
      ok: true,
      value: registration.lastAttemptedSequence,
    });

    const catchUp = await scheduler.triggerNow();
    expect(catchUp).toHaveLength(1);
    expect(catchUp[0]).toMatchObject({ affected: 1, completed: 1, failed: 0 });
    const latest = await adapter.listDocumentChanges({ limit: 1 });
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    const latestSequence = decodeDocumentChangeCursor(
      latest.value.latestCursor
    );
    expect(await adapter.getSavedCapsuleReverificationSequence()).toEqual({
      ok: true,
      value: latestSequence,
    });
    expect((await listSavedCapsules(adapter))[0]?.verification).toMatchObject({
      registrationId: registration.registrationId,
      operationStatus: "completed",
      affectedQuestionState: "affected",
      fromSequence: registration.lastAttemptedSequence,
      throughSequence: latestSequence,
    });
    expect(await Bun.file(capsulePath).text()).toBe(before);
    expect(notifications).toEqual([
      {
        type: "capsule-reverified",
        registrationId: registration.registrationId,
        capsuleId: registration.capsuleId,
        operationStatus: "completed",
        affectedQuestionState: "affected",
        changedAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(notifications)).not.toContain(capsulePath);
    expect(JSON.stringify(notifications)).not.toContain("Mina owns");
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

  test("coalesces one serial drain across multiple Capsules and preserves high-water state on cancellation", async () => {
    const secondPath = join(testDir, "decision-copy.capsule.json");
    await Bun.write(secondPath, await Bun.file(capsulePath).text());
    await registerSavedCapsule(adapter, "default", { filePath: capsulePath });
    await registerSavedCapsule(adapter, "default", { filePath: secondPath });
    expect(
      (
        await adapter.upsertDocument(
          documentInput({
            ...fixture.first,
            sourceHash: "e".repeat(64),
          })
        )
      ).ok
    ).toBe(true);

    const work: Array<(signal: AbortSignal) => Promise<void>> = [];
    const drains: Array<{ affected: number }> = [];
    const scheduler = new SavedCapsuleReverificationScheduler({
      deps: { store: adapter, config, indexName: "default" },
      startBackgroundWork: (operation) => {
        work.push(operation);
        return true;
      },
      onDrain: (result) => drains.push(result),
    });
    scheduler.notifySyncSettled();
    scheduler.notifySyncSettled();
    scheduler.notifySyncSettled();
    expect(work).toHaveLength(1);
    await work[0]!(new AbortController().signal);
    expect(drains).toHaveLength(1);
    expect(drains[0]?.affected).toBe(2);
    expect(
      (await listSavedCapsules(adapter)).map(
        (registration) => registration.verification?.operationStatus
      )
    ).toEqual(["completed", "completed"]);

    const beforeCancellation =
      await adapter.getSavedCapsuleReverificationSequence();
    expect(beforeCancellation.ok).toBe(true);
    expect(
      (
        await adapter.upsertDocument(
          documentInput({
            ...fixture.first,
            sourceHash: "f".repeat(64),
          })
        )
      ).ok
    ).toBe(true);
    const cancelledWork: Array<(signal: AbortSignal) => Promise<void>> = [];
    const cancelled = new SavedCapsuleReverificationScheduler({
      deps: { store: adapter, config, indexName: "default" },
      startBackgroundWork: (operation) => {
        cancelledWork.push(operation);
        return true;
      },
    });
    cancelled.notifySyncSettled();
    const controller = new AbortController();
    controller.abort();
    await cancelledWork[0]!(controller.signal);
    expect(await adapter.getSavedCapsuleReverificationSequence()).toEqual(
      beforeCancellation
    );
    await cancelled.dispose();
    await scheduler.dispose();
  });

  test("retries a drain when registration persistence races its final high-water advance", async () => {
    const first = await registerSavedCapsule(adapter, "default", {
      filePath: capsulePath,
    });
    const secondPath = join(testDir, "decision-racing.capsule.json");
    await Bun.write(secondPath, await Bun.file(capsulePath).text());
    expect(
      (
        await adapter.upsertDocument(
          documentInput({
            ...fixture.first,
            sourceHash: "8".repeat(64),
          })
        )
      ).ok
    ).toBe(true);

    const originalAdvance =
      adapter.setSavedCapsuleReverificationSequence.bind(adapter);
    let persistedDuringAdvance = false;
    const advanceSpy = spyOn(
      adapter,
      "setSavedCapsuleReverificationSequence"
    ).mockImplementation(async (sequence, expectedRegistrationEpoch) => {
      if (!persistedDuringAdvance) {
        persistedDuringAdvance = true;
        expect(
          (
            await adapter.upsertSavedCapsuleRegistration({
              ...first,
              registrationId: `capsule-${sha256Text(secondPath).slice(0, 40)}`,
              filePath: secondPath,
              registeredAtMs: Date.now(),
              updatedAtMs: Date.now(),
              lastAttemptedSequence: first.lastAttemptedSequence,
            })
          ).ok
        ).toBe(true);
      }
      return originalAdvance(sequence, expectedRegistrationEpoch);
    });
    const scheduler = new SavedCapsuleReverificationScheduler({
      deps: { store: adapter, config, indexName: "default" },
      startBackgroundWork: () => false,
    });

    const drains = await scheduler.triggerNow();
    advanceSpy.mockRestore();
    expect(persistedDuringAdvance).toBe(true);
    expect(drains.map(({ affected }) => affected)).toEqual([1, 1]);
    const registrations = await listSavedCapsules(adapter);
    expect(registrations).toHaveLength(2);
    expect(
      registrations.map(
        ({ verification }) => verification?.operationStatus ?? null
      )
    ).toEqual(["completed", "completed"]);
    const latest = await adapter.listDocumentChanges({ limit: 1 });
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    expect(await adapter.getSavedCapsuleReverificationSequence()).toEqual({
      ok: true,
      value: decodeDocumentChangeCursor(latest.value.latestCursor),
    });
  });

  test("rejects a stale receipt and verifies the Capsule re-registered during persistence", async () => {
    const original = await registerSavedCapsule(adapter, "default", {
      filePath: capsulePath,
      notificationPreference: "local",
    });
    expect(
      (
        await adapter.upsertDocument(
          documentInput({
            ...fixture.first,
            sourceHash: "7".repeat(64),
          })
        )
      ).ok
    ).toBe(true);
    const { capsuleId: originalCapsuleId, ...payload } = capsule;
    const replacement = createContextCapsuleV1({
      ...payload,
      goal: "Find the replacement decision owners",
    });
    const replacementBytes = canonicalContextCapsuleJson(replacement);
    const notifications: unknown[] = [];
    const originalPersist =
      adapter.upsertSavedCapsuleVerification.bind(adapter);
    let persistCalls = 0;
    const persistSpy = spyOn(
      adapter,
      "upsertSavedCapsuleVerification"
    ).mockImplementation(async (verification, expectedRegistration) => {
      persistCalls += 1;
      if (persistCalls === 1) {
        await Bun.write(capsulePath, replacementBytes);
        const replacementRegistration = await registerSavedCapsule(
          adapter,
          "default",
          {
            filePath: capsulePath,
            notificationPreference: "local",
          }
        );
        expect(replacementRegistration.capsuleId).toBe(replacement.capsuleId);
        const staleWrite = await originalPersist(
          verification,
          expectedRegistration
        );
        expect(staleWrite).toEqual({ ok: true, value: false });
        expect((await listSavedCapsules(adapter))[0]?.verification).toBeNull();
        return staleWrite;
      }
      return originalPersist(verification, expectedRegistration);
    });
    const scheduler = new SavedCapsuleReverificationScheduler({
      deps: {
        store: adapter,
        config,
        indexName: "default",
        notify: (event) => notifications.push(event),
      },
      startBackgroundWork: () => false,
    });

    const drains = await scheduler.triggerNow();
    persistSpy.mockRestore();
    expect(persistCalls).toBe(2);
    expect(drains.map(({ affected }) => affected)).toEqual([1, 0]);
    const throughSequence = drains[0]!.throughSequence;
    const stored = (await listSavedCapsules(adapter))[0];
    expect(stored).toMatchObject({
      registrationId: original.registrationId,
      capsuleId: replacement.capsuleId,
      fileHash: sha256Text(replacementBytes),
      lastAttemptedSequence: throughSequence,
    });
    expect(stored?.verification).toMatchObject({
      registrationId: original.registrationId,
      operationStatus: "completed",
      throughSequence,
    });
    expect(stored?.verification?.receiptJson).toContain(replacement.capsuleId);
    expect(stored?.verification?.receiptJson).not.toContain(originalCapsuleId);
    expect(await Bun.file(capsulePath).text()).toBe(replacementBytes);
    expect(notifications).toEqual([
      {
        type: "capsule-reverified",
        registrationId: original.registrationId,
        capsuleId: replacement.capsuleId,
        operationStatus: "completed",
        affectedQuestionState: "affected",
        changedAt: expect.any(String),
      },
    ]);
    expect(await adapter.getSavedCapsuleReverificationSequence()).toEqual({
      ok: true,
      value: throughSequence,
    });
  });

  test("honors same-byte notification changes across delete and recreate", async () => {
    const original = await registerSavedCapsule(adapter, "default", {
      filePath: capsulePath,
      notificationPreference: "local",
    });
    const originalSnapshot = await adapter.getSavedCapsuleRegistrationSnapshot(
      original.registrationId
    );
    expect(originalSnapshot.ok && originalSnapshot.value).toBeTruthy();
    if (!originalSnapshot.ok || !originalSnapshot.value) return;
    const originalGeneration = originalSnapshot.value.registrationGeneration;
    expect(
      (
        await adapter.upsertDocument(
          documentInput({
            ...fixture.first,
            sourceHash: "6".repeat(64),
          })
        )
      ).ok
    ).toBe(true);

    const notifications: unknown[] = [];
    const originalPersist =
      adapter.upsertSavedCapsuleVerification.bind(adapter);
    let persistCalls = 0;
    let replacementGeneration = 0;
    const persistSpy = spyOn(
      adapter,
      "upsertSavedCapsuleVerification"
    ).mockImplementation(async (verification, expectedRegistration) => {
      persistCalls += 1;
      if (persistCalls === 1) {
        expect(
          await adapter.deleteSavedCapsuleRegistration(original.registrationId)
        ).toEqual({ ok: true, value: true });
        const replacement = await registerSavedCapsule(adapter, "default", {
          filePath: capsulePath,
          notificationPreference: "none",
        });
        const replacementSnapshot =
          await adapter.getSavedCapsuleRegistrationSnapshot(
            replacement.registrationId
          );
        expect(
          replacementSnapshot.ok && replacementSnapshot.value
        ).toBeTruthy();
        if (!replacementSnapshot.ok || !replacementSnapshot.value) {
          return { ok: true as const, value: false };
        }
        replacementGeneration =
          replacementSnapshot.value.registrationGeneration;
        expect(replacementGeneration).toBeGreaterThan(originalGeneration);
        const beforeSequence =
          replacementSnapshot.value.registration.lastAttemptedSequence;
        const staleWrite = await originalPersist(
          verification,
          expectedRegistration
        );
        expect(staleWrite).toEqual({ ok: true, value: false });
        const afterStale = await adapter.getSavedCapsuleRegistrationSnapshot(
          replacement.registrationId
        );
        expect(afterStale.ok && afterStale.value).toBeTruthy();
        if (afterStale.ok && afterStale.value) {
          expect(afterStale.value.registration.lastAttemptedSequence).toBe(
            beforeSequence
          );
          expect(afterStale.value.registration.verification).toBeNull();
        }
        expect(notifications).toEqual([]);
        return staleWrite;
      }
      return originalPersist(verification, expectedRegistration);
    });
    const scheduler = new SavedCapsuleReverificationScheduler({
      deps: {
        store: adapter,
        config,
        indexName: "default",
        notify: (event) => notifications.push(event),
      },
      startBackgroundWork: () => false,
    });

    const drains = await scheduler.triggerNow();
    persistSpy.mockRestore();
    expect(persistCalls).toBe(2);
    expect(drains.map(({ affected }) => affected)).toEqual([1, 0]);
    const stored = (await listSavedCapsules(adapter))[0];
    expect(stored).toMatchObject({
      registrationId: original.registrationId,
      capsuleId: original.capsuleId,
      fileHash: original.fileHash,
      notificationPreference: "none",
      lastAttemptedSequence: drains[0]!.throughSequence,
    });
    expect(stored?.verification).toMatchObject({
      operationStatus: "completed",
      throughSequence: drains[0]!.throughSequence,
    });
    expect(notifications).toEqual([]);
    expect(JSON.stringify(stored)).not.toContain("registrationGeneration");
    const currentSnapshot = await adapter.getSavedCapsuleRegistrationSnapshot(
      original.registrationId
    );
    expect(
      currentSnapshot.ok &&
        currentSnapshot.value?.registrationGeneration === replacementGeneration
    ).toBe(true);
    expect(await adapter.getSavedCapsuleReverificationSequence()).toEqual({
      ok: true,
      value: drains[0]!.throughSequence,
    });
  });

  test("bounds manual reverification when registration conflicts persist", async () => {
    const registration = await registerSavedCapsule(adapter, "default", {
      filePath: capsulePath,
    });
    const persistSpy = spyOn(
      adapter,
      "upsertSavedCapsuleVerification"
    ).mockResolvedValue({ ok: true, value: false });

    let conflict: unknown;
    try {
      await reverifySavedCapsuleManually(registration.registrationId, {
        store: adapter,
        config,
        indexName: "default",
      });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({
      code: "store_failed",
      message:
        "Saved Context Capsule registration changed repeatedly during verification",
    });
    expect(persistSpy).toHaveBeenCalledTimes(2);
    persistSpy.mockRestore();
    const stored = (await listSavedCapsules(adapter))[0];
    expect(stored?.verification).toBeNull();
    expect(stored?.lastAttemptedSequence).toBe(
      registration.lastAttemptedSequence
    );
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

  test("records missing and invalid saved files without rewriting caller-owned bytes", async () => {
    const missing = await registerSavedCapsule(adapter, "default", {
      filePath: capsulePath,
    });
    await unlink(capsulePath);
    const missingOutcome = await reverifySavedCapsuleManually(
      missing.registrationId,
      { store: adapter, config, indexName: "default" }
    );
    expect(missingOutcome).toMatchObject({
      receipt: null,
      verification: {
        operationStatus: "failed",
        affectedQuestionState: "unknown",
        errorCode: "capsule_file_missing",
      },
    });
    expect(await Bun.file(capsulePath).exists()).toBe(false);

    const invalidBytes = '{"schemaVersion":"1.0","invalid":true}';
    await Bun.write(capsulePath, invalidBytes);
    adapter.getRawDb().run(
      `UPDATE saved_capsule_registrations
         SET file_hash = ?
         WHERE registration_id = ?`,
      [sha256Text(invalidBytes), missing.registrationId]
    );
    const invalidOutcome = await reverifySavedCapsuleManually(
      missing.registrationId,
      { store: adapter, config, indexName: "default" }
    );
    expect(invalidOutcome).toMatchObject({
      receipt: null,
      verification: {
        operationStatus: "failed",
        affectedQuestionState: "unknown",
        errorCode: "capsule_read_failed",
      },
    });
    expect(await Bun.file(capsulePath).text()).toBe(invalidBytes);
  });

  test("reverifies a saved Capsule across SQLite lookup batches", async () => {
    const documents = [...fixture.state.documents];
    const contents = new Map(fixture.state.contents);
    const chunks = new Map(fixture.state.chunks);
    for (let index = 0; index < 901; index += 1) {
      const content = `# Owner\nOwner ${index} holds the decision.\nReview Friday.`;
      const mirrorHash = sha256Text(content);
      const document = documentRow(
        index + 100,
        `large-${index}.md`,
        sha256Text(`source-${index}`),
        mirrorHash
      );
      documents.push(document);
      contents.set(mirrorHash, content);
      chunks.set(mirrorHash, [makeChunk(mirrorHash, content)]);
      expect((await adapter.upsertDocument(documentInput(document))).ok).toBe(
        true
      );
      expect((await adapter.upsertContent(mirrorHash, content)).ok).toBe(true);
      expect(
        (
          await adapter.upsertChunks(
            mirrorHash,
            (chunks.get(mirrorHash) ?? []).map((chunk) => ({
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
    const state = {
      documents,
      contents,
      chunks,
      indexRevision: "saved-large-stable",
    };
    const mock = createVerifierStore(state);
    const capsule = await capsuleFor(mock.store, state);
    const largePath = join(testDir, "large.capsule.json");
    const originalBytes = canonicalContextCapsuleJson(capsule);
    await Bun.write(largePath, originalBytes);
    const registration = await registerSavedCapsule(adapter, "default", {
      filePath: largePath,
    });

    expect(registration.evidence).toHaveLength(903);
    const outcome = await reverifySavedCapsuleManually(
      registration.registrationId,
      { store: adapter, config, indexName: "default" }
    );
    expect(outcome.verification.operationStatus).toBe("completed");
    expect(outcome.receipt?.evidence).toHaveLength(903);
    expect(await Bun.file(largePath).text()).toBe(originalBytes);
  }, 60_000);
});
