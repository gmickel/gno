/** Rebuild pinned synthetic text locally; never transport an index across hosts. */
import { Database } from "bun:sqlite";

import type { StoreResult } from "../../../../src/store/types";

import { scalingCorpus } from "../../../../evals/acceptance/eligible-scaling";
import { SqliteAdapter } from "../../../../src/store/sqlite/adapter";

function must<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
export async function createPinnedSeed(path: string, directory: string) {
  const store = new SqliteAdapter();
  must(await store.open(path, "unicode61"));
  try {
    must(
      await store.syncCollections([
        {
          name: "scaling",
          path: directory,
          pattern: "**/*",
          include: [],
          exclude: [],
        },
      ])
    );
    const db = new Database(path);
    try {
      const content = db.prepare(
        "INSERT INTO content(mirror_hash, markdown) VALUES (?, ?)"
      );
      const document = db.prepare(
        `INSERT INTO documents(id, collection, rel_path, source_hash, source_mime, source_ext, source_size, source_mtime, docid, uri, title, mirror_hash, fts_mirror_hash, active, author, categories) VALUES (?, 'scaling', ?, ?, 'text/markdown', '.md', ?, '2026-09-01T00:00:00.000Z', ?, ?, 'Record', ?, ?, ?, 'Fixture author', '["fixture"]')`
      );
      const chunk = db.prepare(
        "INSERT INTO content_chunks(mirror_hash, seq, pos, text, start_line, end_line, language) VALUES (?, 0, 0, ?, 1, 1, 'en')"
      );
      const fts = db.prepare(
        "INSERT INTO documents_fts(rowid, filepath, title, body) VALUES (?, ?, 'Record', ?)"
      );
      const tag = db.prepare(
        "INSERT INTO doc_tags(document_id, tag, source) VALUES (?, ?, 'frontmatter')"
      );
      db.transaction(() => {
        for (const item of scalingCorpus(201)) {
          content.run(item.hash, item.text);
          document.run(
            item.index + 1,
            item.relPath,
            item.hash,
            item.text.length,
            `#${item.hash.slice(0, 8)}`,
            item.uri,
            item.hash,
            item.hash,
            Number(item.active)
          );
          chunk.run(item.hash, item.text);
          fts.run(item.index + 1, item.relPath, item.text);
          tag.run(item.index + 1, item.rare ? "rare" : "noise");
        }
      })();
    } finally {
      db.close();
    }
  } finally {
    await store.close();
  }
}
