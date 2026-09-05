import type { ChunkRow, DocumentRow } from "../../../../src/store/types";

export interface EligibleFixtureDocument {
  doc: DocumentRow;
  tags: string[];
  chunks: ChunkRow[];
  vectors: number[][];
}

const timestamp = "2026-09-01T00:00:00.000Z";

/** New synthetic identity; never regenerates the frozen fn-143 fixture. */
export function eligibleTopKFixture(): EligibleFixtureDocument[] {
  return Array.from({ length: 201 }, (_, index) => {
    const target = index === 200;
    const mirrorHash = `eligible-v1-${index === 1 ? 0 : index}`;
    const relPath = `scope/${target ? "target" : `noise-${index}`}.md`;
    const texts = target
      ? ["needle deutsche Notiz", `needle ${"background ".repeat(400)}`]
      : ["needle"];
    return {
      doc: {
        id: index + 1,
        collection: "notes",
        relPath,
        sourceHash: `source-${index}`,
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: texts.join("\n").length,
        sourceMtime: target ? timestamp : "2020-01-01T00:00:00.000Z",
        docid: `#fixture-${index}`,
        uri: `gno://notes/${relPath}`,
        title: target ? "Target" : "needle",
        mirrorHash,
        converterId: null,
        converterVersion: null,
        languageHint: null,
        contentType: target ? "decision" : "note",
        categories: [target ? "release" : "noise"],
        author: target ? "Ada Lovelace" : "Noise Writer",
        active: index !== 199,
        ingestVersion: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      tags: target ? ["approved", "release"] : ["noise"],
      chunks: texts.map((text, seq) => ({
        mirrorHash,
        seq,
        pos: seq,
        text,
        startLine: seq + 1,
        endLine: seq + 1,
        language: target && seq === 0 ? "de" : "en",
        tokenCount: null,
        createdAt: timestamp,
      })),
      // Actual deterministic unit vectors, with ties and a nearest wrong-language
      // chunk on the eligible owner. Query is [1, 0]. No embedding claim.
      vectors: target
        ? [
            [1, 0],
            [0.8, 0.6],
          ]
        : [[0.96, 0.28]],
    };
  });
}

/** Exhaustive distance enumeration over independently supplied eligible pairs.
 * No overfetch factor or retrieval implementation participates in the oracle.
 * Owner collapse, affinity and recency remain the consuming pipeline's policy.
 */
export function exhaustiveEligibleVectors(
  documents: EligibleFixtureDocument[],
  eligible: ReadonlySet<string>,
  limit: number
): { owner: string; seq: number; distance: number }[] {
  return documents
    .flatMap(({ doc, chunks, vectors }) =>
      chunks.flatMap((chunk, index) => {
        if (!eligible.has(`${doc.docid}:${chunk.seq}`)) return [];
        const vector = vectors[index]!;
        const distance = 1 - vector[0]! / Math.hypot(...vector);
        return [{ owner: doc.docid, seq: chunk.seq, distance }];
      })
    )
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        a.owner.localeCompare(b.owner) ||
        a.seq - b.seq
    )
    .slice(0, limit);
}
