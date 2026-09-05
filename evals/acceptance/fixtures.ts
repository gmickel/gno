// node:fs/promises: Bun has no directory creation/removal APIs.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
// node:os and node:path: Bun has no equivalents for these path utilities.
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { canonicalFingerprint } from "../agentic/canonical";
import { mustNativeStore } from "../agentic/native-fixture-store";
import {
  generateSyntheticAcceptanceCorpus,
  type AcceptanceDocument,
  type AcceptanceFixtureCase,
} from "../fixtures/acceptance/generate";
import pins from "../fixtures/acceptance/manifest.json";

export type {
  AcceptanceDocument,
  AcceptanceFixtureCase,
} from "../fixtures/acceptance/generate";
export const ACCEPTANCE_FIXTURE_VERSION = "gno-acceptance-fixtures-v1";

/** Exhaustive eligibility, independent of retrieval limits/ranking and SQL candidate selection. */
export function exhaustiveEligibleOracle(
  documents: readonly AcceptanceDocument[],
  query: AcceptanceFixtureCase
) {
  return documents
    .filter(
      (doc) =>
        doc.active &&
        doc.collection === query.collection &&
        (!query.since || doc.sourceMtime >= query.since)
    )
    .flatMap((doc) =>
      doc.chunks
        .filter((chunk) => !query.language || chunk.language === query.language)
        .map((chunk) => ({
          uri: `gno://${doc.collection}/${doc.relPath}`,
          collection: doc.collection,
          relPath: doc.relPath,
          title: doc.title,
          sourceHash: doc.sourceHash,
          mirrorHash: doc.mirrorHash,
          seq: chunk.seq,
          language: chunk.language ?? null,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
        }))
    );
}

export function generateAcceptanceFixtures() {
  const { documents, cases } = generateSyntheticAcceptanceCorpus();
  const oracle = cases.map((query) => ({
    caseId: query.caseId,
    eligible: exhaustiveEligibleOracle(documents, query),
  }));
  return {
    version: ACCEPTANCE_FIXTURE_VERSION,
    documents,
    cases,
    oracle,
    hashes: {
      corpusSha256: canonicalFingerprint(documents),
      queriesSha256: canonicalFingerprint(cases),
      oracleSha256: canonicalFingerprint(oracle),
    },
  };
}

export function verifyAcceptanceFixturePins(
  fixtures = generateAcceptanceFixtures()
): void {
  if (
    fixtures.version !== pins.version ||
    canonicalFingerprint(fixtures.hashes) !== canonicalFingerprint(pins.hashes)
  )
    throw new Error(
      "Acceptance fixture hash drift: add a new version; never refresh the baseline to hide failure"
    );
}

export interface AcceptanceFixtureIndex {
  role: "baseline" | "candidate";
  root: string;
  dbPath: string;
  adapter: SqliteAdapter;
  corpusSha256: string;
  /** Pass to subprocesses. Never assigned to process.env by this helper. */
  env: Record<string, string>;
}

async function buildIndex(
  root: string,
  role: AcceptanceFixtureIndex["role"],
  fixtures: ReturnType<typeof generateAcceptanceFixtures>,
  order: "forward" | "reverse"
): Promise<AcceptanceFixtureIndex> {
  const path = join(root, role);
  await mkdir(path, { recursive: true });
  const dbPath = join(path, "index.sqlite");
  const adapter = new SqliteAdapter();
  try {
    mustNativeStore(
      await adapter.open(dbPath, "unicode61"),
      "open fixture index"
    );
    const collections = [
      ...new Set(fixtures.documents.map((doc) => doc.collection)),
    ].map((name) => ({
      name,
      path: join(path, "corpus", name),
      pattern: "**/*.md",
      include: [],
      exclude: [],
    }));
    for (const collection of collections)
      await mkdir(collection.path, { recursive: true });
    mustNativeStore(
      await adapter.syncCollections(collections),
      "sync fixture collections"
    );
    const documents =
      order === "forward"
        ? fixtures.documents
        : fixtures.documents.toReversed();
    for (const doc of documents) {
      await Bun.write(
        join(path, "corpus", doc.collection, doc.relPath),
        doc.content
      );
      mustNativeStore(
        await adapter.upsertDocument({
          collection: doc.collection,
          relPath: doc.relPath,
          title: doc.title,
          sourceHash: doc.sourceHash,
          mirrorHash: doc.mirrorHash,
          sourceMtime: doc.sourceMtime,
          sourceSize: new TextEncoder().encode(doc.content).length,
          sourceMime: "text/markdown",
          sourceExt: ".md",
          languageHint: doc.language,
        }),
        "insert fixture document"
      );
      mustNativeStore(
        await adapter.upsertContent(doc.mirrorHash, doc.content),
        "insert fixture content"
      );
      mustNativeStore(
        await adapter.upsertChunks(doc.mirrorHash, doc.chunks),
        "insert fixture chunks"
      );
      mustNativeStore(
        await adapter.syncDocumentFts(doc.collection, doc.relPath),
        "sync fixture FTS"
      );
      if (!doc.active)
        mustNativeStore(
          await adapter.markInactive(doc.collection, [doc.relPath]),
          "deactivate fixture document"
        );
    }
    return {
      role,
      root: path,
      dbPath,
      adapter,
      corpusSha256: fixtures.hashes.corpusSha256,
      env: {
        HOME: join(path, "home"),
        XDG_CONFIG_HOME: join(path, "config"),
        XDG_DATA_HOME: join(path, "data"),
        XDG_CACHE_HOME: join(path, "cache"),
        XDG_STATE_HOME: join(path, "state"),
        GNO_CONFIG_DIR: join(path, "config", "gno"),
        GNO_DATA_DIR: join(path, "data", "gno"),
        GNO_CACHE_DIR: join(path, "cache", "gno"),
      },
    };
  } catch (error) {
    await adapter.close();
    throw error;
  }
}

/** Always builds two physical indexes; schema/row mutation on one cannot affect the other. */
export async function setupAcceptanceFixturePair(
  options: { order?: "forward" | "reverse" } = {}
) {
  const fixtures = generateAcceptanceFixtures();
  verifyAcceptanceFixturePins(fixtures);
  const root = await mkdtemp(join(tmpdir(), "gno-acceptance-"));
  const indexes: AcceptanceFixtureIndex[] = [];
  const dispose = async () => {
    for (const index of indexes) await index.adapter.close();
    await rm(root, { recursive: true, force: true });
  };
  try {
    const baseline = await buildIndex(
      root,
      "baseline",
      fixtures,
      options.order ?? "forward"
    );
    indexes.push(baseline);
    const candidate = await buildIndex(
      root,
      "candidate",
      fixtures,
      options.order ?? "forward"
    );
    indexes.push(candidate);
    return { root, fixtures, baseline, candidate, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
