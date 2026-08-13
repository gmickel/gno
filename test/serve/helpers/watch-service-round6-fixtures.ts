/**
 * Shared fixtures for host review round-6 CollectionWatchService tests.
 */

import type { WatchListener } from "node:fs";

import type { Collection } from "../../../src/config/types";
import type { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import type { DocumentRow } from "../../../src/store/types";

import { defaultSyncService } from "../../../src/ingestion";

export {
  createCollection,
  createStubStore,
  createSyncResult,
  installWatchServiceSyncReset,
} from "./watch-service-fixtures";

export const originalInactivate =
  defaultSyncService.inactivateAbsentSources.bind(defaultSyncService);

export function coll(name: string, path: string): Collection {
  return { name, path, pattern: "**/*.md", include: [], exclude: [] };
}

export function stubStore(
  overrides: Partial<SqliteAdapter> = {}
): SqliteAdapter {
  return {
    listActiveDirectChildSourcePaths: async () => ({ ok: true, value: [] }),
    listActiveDescendantSourcePaths: async () => ({ ok: true, value: [] }),
    listActiveSourcePaths: async () => ({ ok: true, value: [] }),
    ...overrides,
  } as unknown as SqliteAdapter;
}

/** Stateful store stub for proven-removal inactivation proofs. */
export function statefulInactiveStore(
  activePaths: string[],
  hooks: {
    getDocument?: SqliteAdapter["getDocument"];
    markInactive?: SqliteAdapter["markInactive"];
    getBacklinksForDoc?: SqliteAdapter["getBacklinksForDoc"];
    getEdgeBacklinksForDoc?: SqliteAdapter["getEdgeBacklinksForDoc"];
    setDocEdges?: SqliteAdapter["setDocEdges"];
    listRecordDocuments?: SqliteAdapter["listRecordDocuments"];
  } = {}
): {
  store: SqliteAdapter;
  inactive: string[];
  docs: Map<string, { active: boolean; id: number; docid: string }>;
} {
  const inactive: string[] = [];
  const docs = new Map(
    activePaths.map((relPath, i) => [
      relPath,
      { active: true, id: i + 1, docid: `doc-${i + 1}` },
    ])
  );
  const store = {
    listActiveDirectChildSourcePaths: async () => ({ ok: true, value: [] }),
    listActiveDescendantSourcePaths: async (
      _c: string,
      dir: string,
      _max: number
    ) => {
      const prefix = dir === "" ? "" : `${dir}/`;
      const value = [...docs.keys()].filter(
        (p) =>
          docs.get(p)?.active &&
          (dir === "" ? true : p === dir || p.startsWith(prefix))
      );
      return { ok: true as const, value };
    },
    listActiveSourcePaths: async () => ({
      ok: true as const,
      value: [...docs.entries()].filter(([, d]) => d.active).map(([p]) => p),
    }),
    listRecordDocuments:
      hooks.listRecordDocuments ??
      (async () => ({ ok: true as const, value: [] })),
    getDocument:
      hooks.getDocument ??
      (async (_c: string, relPath: string) => {
        const row = docs.get(relPath);
        if (!row) {
          return { ok: true as const, value: null };
        }
        return {
          ok: true as const,
          value: {
            id: row.id,
            docid: row.docid,
            collection: "notes",
            relPath,
            active: row.active,
          } as DocumentRow,
        };
      }),
    markInactive:
      hooks.markInactive ??
      (async (_c: string, relPaths: string[]) => {
        let count = 0;
        for (const p of relPaths) {
          const row = docs.get(p);
          if (row?.active) {
            row.active = false;
            inactive.push(p);
            count += 1;
          }
        }
        return { ok: true as const, value: count };
      }),
    getBacklinksForDoc:
      hooks.getBacklinksForDoc ??
      (async () => ({ ok: true as const, value: [] })),
    getEdgeBacklinksForDoc:
      hooks.getEdgeBacklinksForDoc ??
      (async () => ({ ok: true as const, value: [] })),
    setDocEdges:
      hooks.setDocEdges ??
      (async () => ({ ok: true as const, value: undefined })),
    backfillDocEdges: async () => ({ ok: true as const, value: 0 }),
    listDocuments: async () => ({
      ok: true as const,
      value: [...docs.entries()].map(([relPath, row]) => ({
        id: row.id,
        docid: row.docid,
        collection: "notes",
        relPath,
        active: row.active,
      })) as DocumentRow[],
    }),
  } as unknown as SqliteAdapter;
  return { store, inactive, docs };
}

type WatchFactory = typeof import("node:fs").watch;

export function fakeWatch(
  setCb: (cb: (e: string, f: string | null) => void) => void
): WatchFactory {
  return ((
    _p: string,
    _o: { recursive: boolean },
    cb: WatchListener<string>
  ) => {
    setCb(cb as (e: string, f: string | null) => void);
    return { close: () => undefined };
  }) as never;
}

export async function tryMkfifo(path: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["mkfifo", path], {
      stdout: "ignore",
      stderr: "pipe",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
