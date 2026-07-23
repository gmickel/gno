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
  documentRow,
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
    expect(first.fingerprintStatus).toBe("unchanged");
    expect(first.fingerprintReasons).toEqual([]);
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
      contentCode: "mirror_corrupt",
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
    expect(passageReceipt.evidence[0]?.contentCode).toBe("chunk_corrupt");
    expect(passageReceipt.evidence[1]?.contentStatus).toBe("unchanged");
  });

  test("distinguishes missing mirrors and chunks while retaining known hashes", async () => {
    const mirror = verifierFixture(false);
    const mirrorHarness = createVerifierStore(mirror.state);
    const mirrorCapsule = await capsuleFor(mirrorHarness.store, mirror.state);
    const mirrorHash = mirror.state.documents[0]?.mirrorHash ?? "";
    mirror.state.contents.delete(mirrorHash);
    const mirrorReceipt = await verifyContextCapsule(
      mirrorCapsule,
      verifierDeps(mirrorHarness.store, mirrorCapsule)
    );
    expect(mirrorReceipt.evidence[0]).toMatchObject({
      contentStatus: "missing",
      contentCode: "mirror_missing",
      currentSourceHash: mirror.state.documents[0]?.sourceHash,
      currentMirrorHash: mirrorHash,
      currentPassageHash: null,
    });

    const unregistered = verifierFixture(false);
    const unregisteredHarness = createVerifierStore(unregistered.state);
    const unregisteredCapsule = await capsuleFor(
      unregisteredHarness.store,
      unregistered.state
    );
    unregistered.state.documents[0] = {
      ...unregistered.state.documents[0]!,
      mirrorHash: null,
    };
    const unregisteredReceipt = await verifyContextCapsule(
      unregisteredCapsule,
      verifierDeps(unregisteredHarness.store, unregisteredCapsule)
    );
    expect(unregisteredReceipt.evidence[0]).toMatchObject({
      contentStatus: "missing",
      contentCode: "mirror_missing",
      currentSourceHash: unregistered.state.documents[0]?.sourceHash,
      currentMirrorHash: null,
      currentPassageHash: null,
    });

    const chunk = verifierFixture(false);
    const chunkHarness = createVerifierStore(chunk.state);
    const chunkCapsule = await capsuleFor(chunkHarness.store, chunk.state);
    const chunkHash = chunk.state.documents[0]?.mirrorHash ?? "";
    chunk.state.chunks.delete(chunkHash);
    const chunkReceipt = await verifyContextCapsule(
      chunkCapsule,
      verifierDeps(chunkHarness.store, chunkCapsule)
    );
    expect(chunkReceipt.evidence[0]).toMatchObject({
      contentStatus: "stale",
      contentCode: "chunk_missing",
      currentSourceHash: chunk.state.documents[0]?.sourceHash,
      currentMirrorHash: chunkHash,
      currentPassageHash: chunkCapsule.evidence[0]?.passageHash,
    });
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
    const expectedReasons = [
      "config_changed",
      "embedding_model_changed",
    ] as const;
    for (const [index, currentFingerprints] of changedFingerprints.entries()) {
      const receipt = await verifyContextCapsule(capsule, {
        ...verifierDeps(rankingHarness.store, capsule),
        currentFingerprints,
      });
      expect(receipt.rankingStatus).toBe("unchanged");
      expect(receipt.fingerprintStatus).toBe("drifted");
      expect(receipt.fingerprintReasons).toEqual([expectedReasons[index]!]);
      expect(receipt.currentFingerprints).toMatchObject(currentFingerprints);
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
    expect(indexReceipt.rankingStatus).toBe("unchanged");
    expect(indexReceipt.fingerprintReasons).toEqual(["index_changed"]);

    const allCurrentFingerprints = {
      config: sha256Text("all-config"),
      retrieval: sha256Text("all-retrieval"),
      embeddingModel: sha256Text("all-embedding"),
      rerankModel: sha256Text("all-rerank"),
      tokenizer: sha256Text("all-tokenizer"),
    };
    const noRankingReceipt = await verifyContextCapsule(oldIndexCapsule, {
      store: rankingHarness.store,
      currentFingerprints: allCurrentFingerprints,
    });
    expect(noRankingReceipt.rankingStatus).toBe("unavailable");
    expect(noRankingReceipt.currentFingerprints).toEqual({
      ...allCurrentFingerprints,
      index: noRankingReceipt.indexSnapshot.after,
    });
    expect(noRankingReceipt.fingerprintReasons).toEqual([
      "config_changed",
      "retrieval_changed",
      "embedding_model_changed",
      "rerank_model_changed",
      "tokenizer_changed",
      "index_changed",
    ]);
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

  test("rejects noncanonical text before I/O and detects normalization-equivalent mutation", async () => {
    const { state } = verifierFixture(true);
    const harness = createVerifierStore(state);
    const capsule = await capsuleFor(harness.store, state);
    harness.calls.snapshots = 0;
    const nfd = structuredClone(capsule);
    nfd.goal = "Cafe\u0301 decision owner";
    expect(
      verifyContextCapsule(nfd, verifierDeps(harness.store, capsule))
    ).rejects.toMatchObject({
      name: "ContextCapsuleContractError",
      code: "invalid_input",
    });
    const crlf = structuredClone(capsule);
    crlf.query = "decision\r\nowner";
    expect(
      verifyContextCapsule(crlf, verifierDeps(harness.store, capsule))
    ).rejects.toMatchObject({
      name: "ContextCapsuleContractError",
      code: "invalid_input",
    });
    expect(harness.calls.snapshots).toBe(0);

    const { capsuleId: _capsuleId, ...payload } = capsule;
    payload.goal = "Caf\u00e9 decision owner";
    const mutable = createContextCapsuleV1(payload);
    const originalGetContentBatch = harness.store.getContentBatch;
    harness.store.getContentBatch = async (hashes) => {
      mutable.goal = "Cafe\u0301 decision owner";
      return originalGetContentBatch(hashes);
    };
    expect(
      verifyContextCapsule(mutable, verifierDeps(harness.store, mutable))
    ).rejects.toMatchObject({ code: "capsule_mutated_during_verify" });
  });

  test("preserves exact NFD evidence bytes while detecting concurrent evidence mutation", async () => {
    const fixture = verifierFixture(false);
    const originalMirrorHash = fixture.state.documents[0]?.mirrorHash ?? "";
    const nfdText = "Cafe\u0301 owns the decision.";
    const nfdContent = `# Owner\n${nfdText}\nReview Friday.`;
    const nfdMirrorHash = sha256Text(nfdContent);
    fixture.state.documents[0] = {
      ...fixture.state.documents[0]!,
      mirrorHash: nfdMirrorHash,
    };
    fixture.state.contents.delete(originalMirrorHash);
    fixture.state.contents.set(nfdMirrorHash, nfdContent);
    fixture.state.chunks.delete(originalMirrorHash);
    fixture.state.chunks.set(nfdMirrorHash, [
      makeChunk(nfdMirrorHash, nfdContent),
    ]);
    const harness = createVerifierStore(fixture.state);
    const capsule = await capsuleFor(harness.store, fixture.state);
    harness.calls.snapshots = 0;

    expect(capsule.evidence[0]?.text).toBe(nfdText);
    const receipt = await verifyContextCapsule(
      capsule,
      verifierDeps(harness.store, capsule)
    );
    expect(receipt.evidence[0]?.contentStatus).toBe("unchanged");
    expect(harness.calls.snapshots).toBeGreaterThan(0);

    const mutable = structuredClone(capsule);
    const originalGetContentBatch = harness.store.getContentBatch;
    harness.store.getContentBatch = async (hashes) => {
      mutable.evidence[0]!.text = "Caf\u00e9 owns the decision.";
      return originalGetContentBatch(hashes);
    };
    expect(
      verifyContextCapsule(mutable, verifierDeps(harness.store, mutable))
    ).rejects.toMatchObject({ code: "capsule_mutated_during_verify" });
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

  test("requires and recounts the matching active tokenizer before store I/O", async () => {
    const { state } = verifierFixture(true);
    const { store, calls } = createVerifierStore(state);
    const conservative = await capsuleFor(store, state);
    const { capsuleId: _capsuleId, ...payload } = conservative;
    const tokenizerFingerprint = "9".repeat(64);
    const active = createContextCapsuleV1(
      {
        ...payload,
        budget: {
          ...payload.budget,
          estimator: "active_tokenizer",
          tokenizerFingerprint,
        },
        fingerprints: {
          ...payload.fingerprints,
          tokenizer: tokenizerFingerprint,
        },
        capabilities: { ...payload.capabilities, exactTokenCount: true },
        fallbacks: payload.fallbacks.filter(
          (fallback) => fallback.code !== "tokenizer_unavailable"
        ),
        warnings: payload.warnings.filter(
          (warning) => warning.code !== "token_estimate_used"
        ),
      },
      { countTokens: () => 17 }
    );
    calls.snapshots = 0;

    expect(
      verifyContextCapsule(active, verifierDeps(store, active))
    ).rejects.toMatchObject({ code: "tokenizer_unavailable" });
    expect(calls.snapshots).toBe(0);

    const tampered = {
      ...active,
      budget: { ...active.budget, usedTokens: active.budget.usedTokens + 1 },
    };
    expect(
      verifyContextCapsule(tampered, {
        ...verifierDeps(store, active),
        countTokens: () => 17,
        tokenizerFingerprint,
      })
    ).rejects.toMatchObject({ code: "invalid_budget" });
    expect(calls.snapshots).toBe(0);
  });

  test("isolates verification across more than 900 unique mirrors", async () => {
    const documents = [];
    const contents = new Map<string, string>();
    const chunks = new Map<string, ReturnType<typeof makeChunk>[]>();
    for (let index = 0; index < 901; index += 1) {
      const content = `# Owner\nOwner ${index} holds the decision.\nReview Friday.`;
      const mirrorHash = sha256Text(content);
      documents.push(
        documentRow(
          index + 1,
          `large-${index}.md`,
          sha256Text(`source-${index}`),
          mirrorHash
        )
      );
      contents.set(mirrorHash, content);
      chunks.set(mirrorHash, [makeChunk(mirrorHash, content)]);
    }
    const state = {
      documents,
      contents,
      chunks,
      indexRevision: "large-stable",
    };
    const { store, calls } = createVerifierStore(state);
    const capsule = await capsuleFor(store, state);
    calls.snapshots = 0;
    contents.delete(documents[450]!.mirrorHash ?? "");

    const receipt = await verifyContextCapsule(
      capsule,
      verifierDeps(store, capsule)
    );
    expect(receipt.evidence).toHaveLength(901);
    expect(receipt.evidence[450]?.contentCode).toBe("mirror_missing");
    expect(receipt.evidence[449]?.contentStatus).toBe("unchanged");
    expect(receipt.evidence[451]?.contentStatus).toBe("unchanged");
    expect(calls.contents).toHaveLength(1);
    expect(calls.contents[0]).toHaveLength(901);
  });
});
