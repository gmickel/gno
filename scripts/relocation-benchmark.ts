/**
 * Cross-collection relocation benchmark (gno#359).
 *
 * Indexes N synthetic Markdown documents (placeholder text) in one
 * collection, binds a constant vector to every chunk (no model), moves the
 * whole folder on disk to a second collection, and times two ways of telling
 * the index:
 *
 * - ingest: what `gno update` does today (sync both collections): the moved
 *   files become new documents, so every chunk's vector is pending again;
 * - relocate: `gno collection move notes/ data/` (one folder request), then
 *   the same `gno update`, which should find nothing to do.
 *
 * Each arm starts from an identical fresh index in its own temp root.
 *
 * Usage:
 *   bun scripts/relocation-benchmark.ts                 # 2000 documents
 *   bun scripts/relocation-benchmark.ts --docs 500,5000
 *   bun scripts/relocation-benchmark.ts --no-links      # documents without links
 *   bun scripts/relocation-benchmark.ts --docs 1 --workbooks 50   # plus .xlsx files
 *
 * With links (the default) every document links to the next one, so the
 * graph projection that both arms run after a move has link targets to
 * re-resolve; `--no-links` models data files that carry none.
 */

// node:fs/promises for mkdir/mkdtemp/rename (filesystem structure ops)
import { mkdir, mkdtemp, rename } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Collection } from "../src/config/types";

import { SyncService } from "../src/ingestion/sync";
import { SqliteAdapter } from "../src/store/sqlite/adapter";
import { createVectorVariantStore } from "../src/store/vector/variants";
import { safeRm } from "../test/helpers/cleanup";
import { buildLargeWorkbook } from "./generate-large-workbook";

const identity = {
  model: "bench-model",
  modelFingerprint: "bench-weights",
  contextSize: 512,
  truncationPolicy: "bench-tail-v1",
  dimensions: 4,
};

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const paragraph = (i: number, p: number) =>
  `Paragraph ${p} of synthetic document ${i}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(12)}`;

const withLinks = !process.argv.includes("--no-links");
/** Spreadsheets (converted, not plain Markdown) moved alongside the documents. */
const workbooks = Number.parseInt(flag("--workbooks", "0"), 10) || 0;
const workbookScale = Number(flag("--workbook-scale", "0.02"));

async function writeCorpus(root: string, docs: number): Promise<void> {
  if (workbooks > 0) {
    await mkdir(join(root, "sheets"), { recursive: true });
    const bytes = buildLargeWorkbook({ scale: workbookScale });
    for (let i = 0; i < workbooks; i++) {
      // Identical bytes: each file is still its own document and conversion.
      await Bun.write(join(root, "sheets", `sheet-${i}.xlsx`), bytes);
    }
  }
  for (let i = 0; i < docs; i++) {
    const dir = join(root, `folder-${i % 50}`);
    await mkdir(dir, { recursive: true });
    const body = Array.from({ length: 6 }, (_, p) => paragraph(i, p)).join(
      "\n\n"
    );
    await Bun.write(
      join(dir, `doc-${i}.md`),
      `---\ntags: [bench]\n---\n# Document ${i}\n\n${withLinks ? `See [next](doc-${i + 1}.md).\n\n` : ""}${body}\n`
    );
  }
}

interface ArmResult {
  arm: string;
  moveSeconds: number;
  updateSeconds: number;
  totalSeconds: number;
  documentsAdded: number;
  idsKept: number;
  pendingOwners: number;
}

async function runArm(
  arm: "ingest" | "relocate",
  docs: number
): Promise<ArmResult> {
  const root = await mkdtemp(join(tmpdir(), `gno-relocate-bench-${arm}-`));
  try {
    const notes: Collection = {
      name: "notes",
      path: join(root, "notes"),
      pattern: "**/*",
      include: [],
      exclude: [],
    };
    const data: Collection = {
      ...notes,
      name: "data",
      path: join(root, "data"),
    };
    await mkdir(data.path, { recursive: true });
    await writeCorpus(join(notes.path, "batch"), docs);

    const store = new SqliteAdapter();
    const opened = await store.open(join(root, "index.db"), "porter");
    if (!opened.ok) throw new Error(opened.error.message);
    try {
      const synced = await store.syncCollections([notes, data]);
      if (!synced.ok) throw new Error(synced.error.message);
      const sync = new SyncService();
      await sync.syncAll([notes, data], store);
      const vectors = await createVectorVariantStore(
        store.getRawDb(),
        identity
      );
      for (;;) {
        const pending = vectors.pending({ limit: 5000 });
        if (pending.length === 0) break;
        vectors.write(
          pending.map((owner) => ({
            owner,
            embedding: new Float32Array([1, 0, 0, 0]),
          }))
        );
      }
      const before = new Map(
        store
          .getRawDb()
          .query<{ id: number; rel_path: string }, []>(
            "SELECT id, rel_path FROM documents WHERE active = 1"
          )
          .all()
          .map((row) => [row.rel_path, row.id])
      );

      await mkdir(join(data.path), { recursive: true });
      await rename(join(notes.path, "batch"), join(data.path, "batch"));

      let moveSeconds = 0;
      if (arm === "relocate") {
        const started = performance.now();
        const result = await sync.relocateDocuments([notes, data], store, [
          { source: "notes/batch/", destination: "data/batch/" },
        ]);
        moveSeconds = (performance.now() - started) / 1000;
        if (result.refused > 0) {
          throw new Error(
            `refused: ${JSON.stringify(result.items.find((i) => i.status === "refused"))}`
          );
        }
      }
      const updateStarted = performance.now();
      const update = await sync.syncAll([notes, data], store);
      const updateSeconds = (performance.now() - updateStarted) / 1000;

      const after = store
        .getRawDb()
        .query<{ id: number; rel_path: string }, []>(
          "SELECT id, rel_path FROM documents WHERE active = 1 AND collection = 'data'"
        )
        .all();
      return {
        arm,
        moveSeconds,
        updateSeconds,
        totalSeconds: moveSeconds + updateSeconds,
        documentsAdded: update.totalFilesAdded,
        idsKept: after.filter((row) => before.get(row.rel_path) === row.id)
          .length,
        pendingOwners: vectors.countPending(),
      };
    } finally {
      await store.close();
    }
  } finally {
    await safeRm(root);
  }
}

const sizes = flag("--docs", "2000")
  .split(",")
  .map((value) => Number.parseInt(value, 10))
  .filter((value) => Number.isFinite(value) && value > 0);

const rows: string[] = [
  "| documents | arm | move (s) | update (s) | total (s) | added by update | ids kept | pending vectors |",
  "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
];
for (const docs of sizes) {
  for (const arm of ["ingest", "relocate"] as const) {
    const r = await runArm(arm, docs);
    rows.push(
      `| ${docs} | ${r.arm} | ${r.moveSeconds.toFixed(2)} | ${r.updateSeconds.toFixed(2)} | ${r.totalSeconds.toFixed(2)} | ${r.documentsAdded} | ${r.idsKept} | ${r.pendingOwners} |`
    );
    process.stderr.write(`${docs} ${arm}: ${r.totalSeconds.toFixed(2)}s\n`);
  }
}
process.stdout.write(`${rows.join("\n")}\n`);
