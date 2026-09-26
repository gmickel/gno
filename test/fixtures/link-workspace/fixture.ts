/**
 * Synthetic link-workspace fixture: two collections under one `.obsidian/`
 * vault root plus one unrelated collection outside any vault. Content is
 * invented; it is written to a temp dir and never stored in the repository.
 *
 * vault/.obsidian/
 * vault/Spaces/AI    -> collection "ai"   (egress local_only)
 * vault/Spaces/Work  -> collection "work" (egress remote)
 * plain/             -> collection "plain" (no workspace)
 */

// node:fs/promises mkdir/mkdtemp: filesystem structure ops, no Bun equivalent.
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Collection } from "../../../src/config/types";

import { SyncService } from "../../../src/ingestion";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { safeRm } from "../../helpers/cleanup";

export const AI_FILES: Record<string, string> = {
  "Agents/_index.md": "# Agents index\n",
  "Agents/Planner.md": [
    "# Planner",
    "",
    "- vault-root path: [[Spaces/Work/Projects/_index]]",
    "- cross-collection plain: [[Roadmap]]",
    "- same-folder tie-break: [[_index]]",
    "- genuinely tied: [[Shared]]",
    "- explicit prefix: [[work:Roadmap]]",
    "- unknown prefix: [[nope:Roadmap]]",
    "- escaping path: [[../../../../Escape]]",
    "- missing: [[Missing Note]]",
    "- only inbound link of a work note: [[Lonely]]",
    "",
  ].join("\n"),
  "_index.md": "# AI index\n",
  "Private.md": "# Private\n\nConfidential planning notes.\n",
  // Titled "Roadmap" by heading: collection-scoped resolution picks it for
  // [[Roadmap]]; workspace resolution prefers the file named Roadmap.md.
  "Titled.md": "# Roadmap\n\nAn AI note titled Roadmap.\n",
};

export const WORK_FILES: Record<string, string> = {
  "Projects/_index.md": "# Projects index\n",
  "Roadmap.md": "# Roadmap\n\nSee [[Planner]] and [[Private]].\n",
  "A/Shared.md": "# Shared A\n",
  "B/Shared.md": "# Shared B\n",
  "Lonely.md": "# Lonely\n",
};

export const PLAIN_FILES: Record<string, string> = {
  "Home.md": "# Home\n\n[[Roadmap]] [[Other]]\n",
  "Other.md": "# Other\n",
  "Titled.md": "# Roadmap\n\nA plain note titled Roadmap.\n",
};

export interface LinkWorkspaceFixture {
  root: string;
  vault: string;
  store: SqliteAdapter;
  collections: Collection[];
  service: SyncService;
  write(collection: string, relPath: string, body: string): Promise<void>;
  sync(): Promise<void>;
  /** Re-sync collection config (workspace detection) into the store. */
  reconfigure(collections: Collection[]): Promise<void>;
  docId(uri: string): number;
  close(): Promise<void>;
}

const collection = (
  name: string,
  path: string,
  extra: Partial<Collection> = {}
): Collection => ({
  name,
  path,
  pattern: "**/*.md",
  include: [],
  exclude: [],
  ...extra,
});

export async function openLinkWorkspaceFixture(
  options: { aiWorkspaceRoot?: string | false } = {}
): Promise<LinkWorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), "gno-link-workspace-"));
  const vault = join(root, "vault");
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  const dirs = {
    ai: join(vault, "Spaces", "AI"),
    work: join(vault, "Spaces", "Work"),
    plain: join(root, "plain"),
  };
  const files: Record<string, Record<string, string>> = {
    ai: AI_FILES,
    work: WORK_FILES,
    plain: PLAIN_FILES,
  };
  for (const [name, entries] of Object.entries(files)) {
    for (const [relPath, body] of Object.entries(entries)) {
      const path = join(dirs[name as keyof typeof dirs], relPath);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, body);
    }
  }
  const collections: Collection[] = [
    collection("ai", dirs.ai, {
      egressPolicy: "local_only",
      ...(options.aiWorkspaceRoot === undefined
        ? {}
        : { workspaceRoot: options.aiWorkspaceRoot }),
    }),
    collection("work", dirs.work, { egressPolicy: "remote" }),
    collection("plain", dirs.plain),
  ];
  const store = new SqliteAdapter();
  const opened = await store.open(":memory:", "porter");
  if (!opened.ok) throw new Error(opened.error.message);
  const synced = await store.syncCollections(collections);
  if (!synced.ok) throw new Error(synced.error.message);
  const service = new SyncService();
  const fixture: LinkWorkspaceFixture = {
    root,
    vault,
    store,
    collections,
    service,
    async write(name, relPath, body) {
      const base = dirs[name as keyof typeof dirs];
      const path = join(base, relPath);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, body);
    },
    async sync() {
      await service.syncAll(fixture.collections, store);
    },
    async reconfigure(next) {
      fixture.collections = next;
      const result = await store.syncCollections(next);
      if (!result.ok) throw new Error(result.error.message);
    },
    docId(uri) {
      const row = store
        .getRawDb()
        .query<{ id: number }, [string]>(
          "SELECT id FROM documents WHERE uri = ? AND active = 1"
        )
        .get(uri);
      if (!row) throw new Error(`No active document ${uri}`);
      return row.id;
    },
    async close() {
      await store.close();
      await safeRm(root);
    },
  };
  await fixture.sync();
  return fixture;
}
