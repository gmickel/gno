/** Opt-in native bridge; preparation never initializes a model. */
import { Database } from "bun:sqlite";
// Bun has no directory creation primitive.
import { mkdir } from "node:fs/promises";

import { scalingCorpus } from "../../../../evals/acceptance/eligible-scaling";
import { canonicalFingerprint } from "../../../../evals/agentic/canonical";
import { ConfigSchema } from "../../../../src/config/types";
import { formatDocForEmbedding } from "../../../../src/pipeline/contextual";
import { createGnoClient } from "../../../../src/sdk/client";

const directory = process.env.QA_RUN;
const model = process.env.QA_MODEL;
if (!directory || !model || !model.startsWith("file:"))
  throw new Error("QA_RUN and cached file: QA_MODEL required");
const path = `${directory}/index.sqlite`;
const hash = (value: string | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");
const fixture = scalingCorpus(201);
const query = "needle noise 0";
const config = ConfigSchema.parse({
  version: "1.0" as const,
  ftsTokenizer: "unicode61" as const,
  collections: [
    {
      name: "scaling",
      path: directory,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    },
  ],
  contexts: [],
  projectAffinity: { enabled: false, contribution: 0.03 },
  models: {
    activePreset: "native-bridge",
    presets: [
      {
        id: "native-bridge",
        name: "Native eligibility bridge",
        embed: model,
        rerank: model,
        gen: model,
      },
    ],
    warmModelTtl: 300000,
  },
});
async function write(name: string, value: unknown) {
  await Bun.write(
    `${directory}/${name}.json`,
    `${JSON.stringify(value, null, 2)}\n`
  );
}
function assertBase(db: Database) {
  const rows = db
    .query(
      `SELECT d.id,d.uri,d.mirror_hash AS hash,d.title,d.active,c.text FROM documents d JOIN content_chunks c ON c.mirror_hash=d.mirror_hash AND c.seq=0 ORDER BY d.id`
    )
    .all();
  const expected = fixture.map((item) => ({
    id: item.index + 1,
    uri: item.uri,
    hash: item.hash,
    title: "Record",
    active: Number(item.active),
    text: item.text,
  }));
  if (canonicalFingerprint(rows) !== canonicalFingerprint(expected))
    throw new Error("Pinned 201-owner source identity mismatch");
}
if (process.argv[2] === "prepare") {
  const base = process.env.QA_BASE_DB;
  if (!base) throw new Error("QA_BASE_DB required");
  if (await Bun.file(path).exists())
    throw new Error("Refusing existing run database");
  await mkdir(directory, { recursive: true });
  const db = new Database(base, { readonly: true });
  try {
    assertBase(db);
    db.query("VACUUM INTO ?").run(path);
  } finally {
    db.close();
  }
  await write("config", config);
  await write("manifest", {
    protocol: "fn148-native-201-bridge-v1",
    query,
    model,
    sourceFixture: "eligible-scaling-v1",
    corpusHash: canonicalFingerprint(fixture),
    embeddingReplacement:
      "Native model embeddings replace synthetic search identity; original synthetic rows remain under their separate model identity and are not native evidence",
    documents: fixture.map(({ vector: _vector, ...item }) => item),
    limits: [1, 10],
    expectedTarget: fixture.at(-1)!.uri,
    expectedNativeOperations:
      "One embed operation (198 active chunks), five query calls, no expansion/reranking",
  });
  console.log("Prepared only; no native model initialized");
} else if (process.argv[2] === "run") {
  if (process.env.QA_NATIVE_SLOT !== "granted")
    throw new Error("Explicit host native slot grant required");
  const db = new Database(path, { readonly: true });
  const client = await createGnoClient({
    config,
    dbPath: path,
    downloadPolicy: { offline: true, allowDownload: false },
  });
  try {
    assertBase(db);
    await write("model", {
      model,
      sha256: hash(
        new Uint8Array(await Bun.file(model.slice(5)).arrayBuffer())
      ),
    });
    const embedded = await client.embed();
    await write("embed", embedded);
    const partitions = db
      .query<
        {
          state: string;
          activated_epoch: number | null;
          current_epoch: number;
        },
        [string]
      >(
        "SELECT p.*, e.epoch AS current_epoch FROM vector_partitions p CROSS JOIN vector_variant_epoch e WHERE p.model=?"
      )
      .all(model);
    await write("partitions", partitions);
    if (
      partitions.length !== 1 ||
      partitions.some(
        (partition) =>
          partition.state !== "active" ||
          partition.activated_epoch !== partition.current_epoch
      )
    )
      throw new Error("Native owner partition is not fully activated");
    const owners = db
      .query<
        {
          uri: string;
          title: string;
          text: string;
          input_hash: string;
          embedding: Uint8Array;
          partition_id: string;
        },
        [string]
      >(
        `SELECT d.uri,d.title,c.text,v.input_hash,v.embedding,o.partition_id FROM documents d JOIN content_chunks c ON c.mirror_hash=d.mirror_hash JOIN vector_owners o ON o.document_id=d.id AND o.seq=c.seq JOIN vector_variants v ON v.variant_id=o.variant_id JOIN vector_partitions p ON p.partition_id=o.partition_id WHERE d.active=1 AND p.model=? ORDER BY d.uri`
      )
      .all(model);
    if (owners.length !== fixture.filter((item) => item.active).length)
      throw new Error("Native owner coverage incomplete");
    const ownerProof = owners.map(({ embedding, ...owner }) => ({
      ...owner,
      vectorHash: hash(embedding),
      expectedInputHash: hash(
        formatDocForEmbedding(owner.text, owner.title, model)
      ),
    }));
    await write("owners", ownerProof);
    if (
      ownerProof.some((owner) => owner.input_hash !== owner.expectedInputHash)
    )
      throw new Error("Current native owner input hash mismatch");
    const broad = await client.vsearch(query, {
      limit: 201,
      collection: "scaling",
    });
    await write("broad", broad);
    if (!broad.meta.vectorsUsed) throw new Error("Broad native vector failure");
    const eligible = new Set(
      fixture.filter((item) => item.active && item.rare).map((item) => item.uri)
    );
    const expected = broad.results.filter((row) => eligible.has(row.uri));
    const targetRank = broad.results.findIndex((row) => eligible.has(row.uri));
    await write("oracle", {
      targetRank,
      excludedAhead: targetRank,
      expected,
      completeBroadCount: broad.results.length,
    });
    if (expected.length !== 1 || targetRank < 10)
      throw new Error(
        "Native bridge does not exhibit ten excluded owners ahead of target; scenario incomplete, fixture unchanged"
      );
    const checks = [];
    for (const limit of [1, 10]) {
      const options = { limit, collection: "scaling", tagsAll: ["rare"] };
      const vector = await client.vsearch(query, options);
      await write(`vector-${limit}`, vector);
      if (
        !vector.meta.vectorsUsed ||
        canonicalFingerprint(JSON.parse(JSON.stringify(vector.results))) !==
          canonicalFingerprint(JSON.parse(JSON.stringify(expected)))
      )
        throw new Error(`Native filtered vector mismatch K=${limit}`);
      const hybrid = await client.query(query, {
        ...options,
        noExpand: true,
        noRerank: true,
        noGraph: true,
      });
      await write(`hybrid-${limit}`, hybrid);
      if (
        !hybrid.meta.vectorsUsed ||
        hybrid.results.length !== 1 ||
        hybrid.results[0]!.uri !== expected[0]!.uri
      )
        throw new Error(`Native filtered hybrid owner mismatch K=${limit}`);
      checks.push({
        limit,
        vectorFullRowsExact: true,
        hybridOwnerExact: true,
        vectorsUsed: true,
      });
    }
    await write("result", {
      status: "captured",
      checks,
      limitation:
        "Hybrid score assembly is not compared to an independent native fusion implementation; deterministic matrix supplies that declared-domain proof",
    });
  } catch (error) {
    await write("failure", {
      error: String(error),
      status: "incomplete-or-failed",
      retained: true,
    });
    throw error;
  } finally {
    await client.close();
    db.close();
  }
} else throw new Error("Use prepare or run");
