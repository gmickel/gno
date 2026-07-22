import { describe, expect, test } from "bun:test";

import type { ActivationIndexDocument } from "../../src/store/types";

import { fingerprintActivationIndex } from "../../src/core/activation-probe";

const DOCUMENTS: ActivationIndexDocument[] = [
  {
    id: 1,
    uri: "gno://notes/proof.md",
    sourceHash: "a".repeat(64),
    mirrorHash: "b".repeat(64),
    active: true,
  },
];

describe("activation index fingerprint", () => {
  test("invalidates when schema version or FTS tokenizer changes", () => {
    const base = {
      collection: "notes",
      indexName: "default",
      schemaVersion: 13,
      ftsTokenizer: "unicode61",
      ftsStateHash: "c".repeat(64),
      documents: DOCUMENTS,
    };

    const current = fingerprintActivationIndex(base);
    const schemaChanged = fingerprintActivationIndex({
      ...base,
      schemaVersion: 14,
    });
    const tokenizerChanged = fingerprintActivationIndex({
      ...base,
      ftsTokenizer: "trigram",
    });

    expect(current).toMatch(/^[a-f0-9]{64}$/);
    expect(schemaChanged).not.toBe(current);
    expect(tokenizerChanged).not.toBe(current);
    expect(tokenizerChanged).not.toBe(schemaChanged);
  });
});
