import { describe, expect, test } from "bun:test";

import { deriveDocid } from "../../src/app/constants";
import {
  canonicalContextCapsuleJson,
  createContextCapsuleV1,
} from "../../src/core/context-capsule";
import { sha256Text } from "../../src/core/context-capsule-validation";
import {
  canonicalContextCapsuleVerificationJson,
  verifyContextCapsule,
} from "../../src/core/context-verifier";
import {
  capsuleFor,
  createVerifierStore,
  FINGERPRINTS,
  makeChunk,
  verifierDeps,
  verifierFixture,
} from "./context-verifier-fixture";

describe("Context Capsule verifier", () => {
  test("returns deterministic unchanged receipts for distinct same-mirror documents", async () => {
    const { state } = verifierFixture(true);
    const { store, calls } = createVerifierStore(state);
    const capsule = await capsuleFor(store, state);
    calls.snapshots = 0;
    const inputBytes = canonicalContextCapsuleJson(capsule);
    const first = await verifyContextCapsule(
      capsule,
      verifierDeps(store, capsule)
    );
    const second = await verifyContextCapsule(
      capsule,
      verifierDeps(store, capsule)
    );

    expect(first.contentStatus).toBe("unchanged");
    expect(first.rankingStatus).toBe("unchanged");
    expect(first.evidence.map((item) => item.uri)).toEqual(
      capsule.evidence.map((item) => item.uri)
    );
    expect(canonicalContextCapsuleVerificationJson(first)).toBe(
      canonicalContextCapsuleVerificationJson(second)
    );
    expect(canonicalContextCapsuleJson(capsule)).toBe(inputBytes);
    expect(calls.documents).toHaveLength(2);
    expect(calls.contents.every((call) => call.length === 1)).toBe(true);
    expect(calls.chunks.every((call) => call.length === 1)).toBe(true);
  });

  test("isolates changed source, missing source, and corrupt mirror statuses", async () => {
    const changed = verifierFixture(false);
    const changedHarness = createVerifierStore(changed.state);
    const changedCapsule = await capsuleFor(
      changedHarness.store,
      changed.state
    );
    const replacementHash = sha256Text("replacement-source");
    changed.state.documents[0] = {
      ...changed.state.documents[0]!,
      sourceHash: replacementHash,
      docid: deriveDocid(replacementHash),
    };
    const changedReceipt = await verifyContextCapsule(
      changedCapsule,
      verifierDeps(changedHarness.store, changedCapsule)
    );
    expect(changedReceipt.evidence[0]).toMatchObject({
      contentStatus: "stale",
      contentCode: "source_stale",
      currentSourceHash: replacementHash,
    });
    expect(changedReceipt.evidence[1]?.contentStatus).toBe("unchanged");

    const missing = verifierFixture(false);
    const missingHarness = createVerifierStore(missing.state);
    const missingCapsule = await capsuleFor(
      missingHarness.store,
      missing.state
    );
    missing.state.documents[0] = {
      ...missing.state.documents[0]!,
      active: false,
    };
    const missingReceipt = await verifyContextCapsule(
      missingCapsule,
      verifierDeps(missingHarness.store, missingCapsule)
    );
    expect(missingReceipt.evidence[0]?.contentCode).toBe("source_missing");
    expect(missingReceipt.evidence[1]?.contentStatus).toBe("unchanged");

    const corrupt = verifierFixture(false);
    const corruptHarness = createVerifierStore(corrupt.state);
    const corruptCapsule = await capsuleFor(
      corruptHarness.store,
      corrupt.state
    );
    const firstHash = corrupt.state.documents[0]?.mirrorHash ?? "";
    const crlf = corrupt.firstContent.replaceAll("\n", "\r\n");
    corrupt.state.contents.set(firstHash, crlf);
    const corruptReceipt = await verifyContextCapsule(
      corruptCapsule,
      verifierDeps(corruptHarness.store, corruptCapsule)
    );
    expect(corruptReceipt.evidence[0]).toMatchObject({
      contentCode: "mirror_stale",
      currentMirrorHash: sha256Text(crlf),
    });
    expect(corruptReceipt.evidence[1]?.contentStatus).toBe("unchanged");
  });

  test("returns current hashes for changed mirrors and detects chunk span drift", async () => {
    const mirror = verifierFixture(false);
    const mirrorHarness = createVerifierStore(mirror.state);
    const mirrorCapsule = await capsuleFor(mirrorHarness.store, mirror.state);
    const updatedContent = "# Owner\nLee owns the decision.\nReview Friday.";
    const updatedHash = sha256Text(updatedContent);
    mirror.state.documents[0] = {
      ...mirror.state.documents[0]!,
      mirrorHash: updatedHash,
    };
    mirror.state.contents.set(updatedHash, updatedContent);
    mirror.state.chunks.set(updatedHash, [
      makeChunk(updatedHash, updatedContent),
    ]);
    const mirrorReceipt = await verifyContextCapsule(
      mirrorCapsule,
      verifierDeps(mirrorHarness.store, mirrorCapsule)
    );
    expect(mirrorReceipt.evidence[0]).toMatchObject({
      contentCode: "mirror_stale",
      currentMirrorHash: updatedHash,
      currentPassageHash: sha256Text("Lee owns the decision."),
    });

    const passage = verifierFixture(false);
    const passageHarness = createVerifierStore(passage.state);
    const passageCapsule = await capsuleFor(
      passageHarness.store,
      passage.state
    );
    const passageHash = passage.state.documents[0]?.mirrorHash ?? "";
    const passageChunk = passage.state.chunks.get(passageHash)?.[0];
    if (!passageChunk) throw new Error("missing passage chunk fixture");
    passage.state.chunks.set(passageHash, [{ ...passageChunk, pos: 0 }]);
    const passageReceipt = await verifyContextCapsule(
      passageCapsule,
      verifierDeps(passageHarness.store, passageCapsule)
    );
    expect(passageReceipt.evidence[0]?.contentCode).toBe("passage_stale");
    expect(passageReceipt.evidence[1]?.contentStatus).toBe("unchanged");
  });

  test("separates rank, config, model, and saved-index fingerprint drift", async () => {
    const ranking = verifierFixture(true);
    const rankingHarness = createVerifierStore(ranking.state);
    const capsule = await capsuleFor(rankingHarness.store, ranking.state);
    const rankDeps = verifierDeps(rankingHarness.store, capsule);
    rankDeps.resolveCurrentRanks = async () =>
      new Map(capsule.evidence.map((item) => [item.evidenceId, 9]));
    expect((await verifyContextCapsule(capsule, rankDeps)).rankingStatus).toBe(
      "reranked"
    );

    const changedFingerprints = [
      { ...FINGERPRINTS, config: sha256Text("changed-config") },
      {
        ...FINGERPRINTS,
        embeddingModel: sha256Text("new-embedding-model"),
      },
    ];
    for (const currentFingerprints of changedFingerprints) {
      const receipt = await verifyContextCapsule(capsule, {
        ...verifierDeps(rankingHarness.store, capsule),
        currentFingerprints,
      });
      expect(receipt.rankingStatus).toBe("reranked");
    }

    const { capsuleId: _capsuleId, ...savedPayload } = capsule;
    savedPayload.retrieval.indexSnapshot = {
      before: sha256Text("older-index"),
      after: sha256Text("older-index"),
      stable: true,
    };
    const oldIndexCapsule = createContextCapsuleV1(savedPayload);
    const indexReceipt = await verifyContextCapsule(oldIndexCapsule, {
      ...verifierDeps(rankingHarness.store, oldIndexCapsule),
      resolveCurrentRanks: async () =>
        new Map(
          oldIndexCapsule.evidence.map((item) => [
            item.evidenceId,
            item.retrievalRank,
          ])
        ),
    });
    expect(indexReceipt.rankingStatus).toBe("reranked");
  });

  test("rejects noncanonical URI, evidence identity, and budget before resolving", async () => {
    const { state } = verifierFixture(true);
    const { store, calls } = createVerifierStore(state);
    const capsule = await capsuleFor(store, state);
    calls.snapshots = 0;

    const invalidBudget = structuredClone(capsule);
    invalidBudget.budget.usedBytes += 1;
    const invalidUri = structuredClone(capsule);
    invalidUri.evidence[0]!.uri = "gno://notes/%2f";
    const invalidEvidenceId = structuredClone(capsule);
    invalidEvidenceId.evidence[0]!.evidenceId = sha256Text("wrong-evidence-id");
    for (const invalid of [invalidBudget, invalidUri, invalidEvidenceId]) {
      expect(
        verifyContextCapsule(invalid, verifierDeps(store, capsule))
      ).rejects.toMatchObject({ name: "ContextCapsuleContractError" });
    }
    expect(calls.snapshots).toBe(0);
  });

  test("fails the operation deterministically when the index snapshot drifts", async () => {
    const { state } = verifierFixture(true);
    const { store, calls } = createVerifierStore(state);
    const capsule = await capsuleFor(store, state);
    calls.snapshots = 0;
    state.mutateSnapshotAfter = 1;
    expect(
      verifyContextCapsule(capsule, verifierDeps(store, capsule))
    ).rejects.toMatchObject({ code: "index_changed_during_verify" });
  });
});
