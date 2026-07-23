import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

const sha = (character: string): string => character.repeat(64);
const registrationId = `capsule-${"a".repeat(40)}`;

const evidence = {
  evidenceId: sha("b"),
  canonicalUri: "gno://notes/decision.md",
  collection: "notes",
  sourceHash: sha("c"),
  mirrorHash: sha("d"),
  passageHash: sha("e"),
};

const registration = {
  registrationId,
  filePath: "/tmp/decision.capsule.json",
  fileHash: sha("f"),
  capsuleId: sha("0"),
  indexName: "default",
  question: "Who owns the decision?",
  label: "Decision",
  notificationPreference: "local",
  registeredAtMs: 1,
  updatedAtMs: 2,
  lastAttemptedSequence: 3,
  evidence: [evidence],
  verification: null,
};

describe("saved Context Capsule lifecycle schemas", () => {
  let registrationSchema: object;
  let watchSchema: object;
  let listSchema: object;
  let unwatchSchema: object;
  let eventSchema: object;

  beforeAll(async () => {
    registrationSchema = await loadSchema("saved-capsule-registration");
    watchSchema = await loadSchema("saved-capsule-watch");
    listSchema = await loadSchema("saved-capsule-list");
    unwatchSchema = await loadSchema("saved-capsule-unwatch");
    eventSchema = await loadSchema("capsule-reverified-event");
  });

  test("accepts metadata-only registration, list, and removal receipts", () => {
    expect(assertValid(registration, registrationSchema)).toBe(true);
    expect(assertValid(registration, watchSchema)).toBe(true);
    expect(
      assertInvalid(
        {
          ...registration,
          verification: {
            registrationId,
            triggerKind: "manual",
            fromSequence: 0,
            throughSequence: 0,
            operationStatus: "failed",
            affectedQuestionState: "unknown",
            affectedReasons: [],
            receiptJson: null,
            receiptHash: null,
            errorCode: "verification_failed",
            errorMessage: "failed",
            verifiedAtMs: 1,
          },
        },
        watchSchema
      )
    ).toBe(true);
    expect(
      assertValid(
        { schemaVersion: "1.0", registrations: [registration] },
        listSchema
      )
    ).toBe(true);
    expect(
      assertValid(
        { schemaVersion: "1.0", registrationId, removed: true },
        unwatchSchema
      )
    ).toBe(true);
  });

  test("keeps completed receipts and operation failures exclusive", () => {
    const completed = {
      registrationId,
      triggerKind: "journal",
      fromSequence: 2,
      throughSequence: 3,
      operationStatus: "completed",
      affectedQuestionState: "affected",
      affectedReasons: ["content_stale"],
      receiptJson: '{"schemaVersion":"1.0"}',
      receiptHash: sha("1"),
      errorCode: null,
      errorMessage: null,
      verifiedAtMs: 4,
    };
    expect(
      assertValid(
        { ...registration, verification: completed },
        registrationSchema
      )
    ).toBe(true);
    expect(
      assertInvalid(
        {
          ...registration,
          verification: {
            ...completed,
            errorCode: "verification_failed",
            errorMessage: "must not coexist",
          },
        },
        registrationSchema
      )
    ).toBe(true);

    const failed = {
      ...completed,
      triggerKind: "manual",
      operationStatus: "failed",
      affectedQuestionState: "unknown",
      affectedReasons: [],
      receiptJson: null,
      receiptHash: null,
      errorCode: "capsule_file_changed",
      errorMessage: "Saved Context Capsule file changed after registration",
    };
    expect(
      assertValid({ ...registration, verification: failed }, registrationSchema)
    ).toBe(true);
    expect(
      assertInvalid(
        {
          ...registration,
          verification: { ...failed, affectedQuestionState: "affected" },
        },
        registrationSchema
      )
    ).toBe(true);
  });

  test("closes the local notification payload against private metadata", () => {
    const event = {
      type: "capsule-reverified",
      registrationId,
      capsuleId: sha("0"),
      operationStatus: "completed",
      affectedQuestionState: "unaffected",
      changedAt: "2026-07-23T12:00:00.000Z",
    };
    expect(assertValid(event, eventSchema)).toBe(true);
    for (const privateField of [
      "question",
      "label",
      "filePath",
      "uri",
      "sourceHash",
      "receipt",
      "token",
    ]) {
      expect(
        assertInvalid({ ...event, [privateField]: "private" }, eventSchema)
      ).toBe(true);
    }
    expect(
      assertInvalid(
        {
          ...event,
          operationStatus: "failed",
          affectedQuestionState: "affected",
        },
        eventSchema
      )
    ).toBe(true);
  });
});
