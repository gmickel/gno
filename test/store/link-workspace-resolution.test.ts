/**
 * Workspace-wide wiki link resolution over the synthetic two-collection vault
 * (R1-R4, A3, A5-A9, A11).
 */

import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises: filesystem structure ops for fixtures, no Bun equivalent.
import { mkdir, mkdtemp, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { GraphLinkTarget } from "../../src/store/sqlite/graph-link-resolver";

import { validateCollectionWorkspaceRoots } from "../../src/config/loader";
import { ConfigSchema } from "../../src/config/types";
import { SyncService } from "../../src/ingestion";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import {
  captureAuditLinkSnapshot,
  resolveGraphLinkTargets,
} from "../../src/store/sqlite/graph-link-resolver";
import {
  openLinkWorkspaceFixture,
  type LinkWorkspaceFixture,
} from "../fixtures/link-workspace/fixture";
import { safeRm } from "../helpers/cleanup";

let fixture: LinkWorkspaceFixture | undefined;
const cleanups: string[] = [];

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  for (const path of cleanups.splice(0)) await safeRm(path);
});

interface Outcome {
  uri: string | null;
  reason: string | null;
  scope: string | null;
  traversable: boolean;
  candidates: string[];
}

const outcomes = (store: SqliteAdapter): Map<string, Outcome> => {
  const snapshot = captureAuditLinkSnapshot(store.getRawDb());
  const uri = new Map(snapshot.documents.map((doc) => [doc.id, doc.uri]));
  const result = new Map<string, Outcome>();
  for (const link of snapshot.links) {
    const prefix = link.targetCollection !== link.sourceCollection;
    const key = `${link.sourceUri} ${prefix ? `${link.targetCollection}:` : ""}${link.targetRef}`;
    result.set(key, {
      uri: link.resolved ? (uri.get(link.resolved.targetId) ?? null) : null,
      reason: link.resolved?.reason ?? null,
      scope: link.resolved?.scope ?? null,
      traversable: link.resolved ? link.resolved.traversable !== false : false,
      candidates: (link.resolved?.candidates ?? []).map(
        (candidate) => uri.get(candidate.id) ?? ""
      ),
    });
  }
  return result;
};

const PLANNER = "gno://ai/Agents/Planner.md";

const collectionRows = async (store: SqliteAdapter) => {
  const result = await store.getCollections();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("link workspace membership (R1)", () => {
  test("collections under one .obsidian root form a workspace; others stay collection-scoped", async () => {
    fixture = await openLinkWorkspaceFixture();
    const rows = await collectionRows(fixture.store);
    const byName = new Map(rows.map((row) => [row.name, row]));
    expect(byName.get("ai")?.workspaceSource).toBe("detected");
    expect(byName.get("work")?.workspaceRoot).toBe(
      byName.get("ai")?.workspaceRoot
    );
    expect(byName.get("ai")?.workspaceRoot?.endsWith("vault")).toBe(true);
    expect(byName.get("plain")).toMatchObject({
      workspaceSource: "none",
      workspaceRoot: null,
    });
  });

  test("invalid workspaceRoot settings are validation errors naming the collection", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-ws-config-"));
    cleanups.push(root);
    await mkdir(join(root, "notes"));
    await mkdir(join(root, "elsewhere"));
    const config = ConfigSchema.parse({
      version: "1.0",
      collections: [
        { name: "rel", path: join(root, "notes"), workspaceRoot: "vault" },
        {
          name: "gone",
          path: join(root, "notes"),
          workspaceRoot: join(root, "missing"),
        },
        {
          name: "outside",
          path: join(root, "notes"),
          workspaceRoot: join(root, "elsewhere"),
        },
        { name: "ok", path: join(root, "notes"), workspaceRoot: root },
        { name: "off", path: join(root, "notes"), workspaceRoot: false },
      ],
    });
    expect(
      validateCollectionWorkspaceRoots(config).map((issue) => issue.message)
    ).toEqual([
      'Collection "rel": workspaceRoot must be an absolute path',
      'Collection "gone": workspaceRoot does not exist or is not a directory',
      'Collection "outside": workspaceRoot must contain the collection root',
    ]);
  });
});

describe("workspace resolution order (R2, R3)", () => {
  test("fixture links resolve per the ranking tuple", async () => {
    fixture = await openLinkWorkspaceFixture();
    const result = outcomes(fixture.store);
    expect(result.get(`${PLANNER} Spaces/Work/Projects/_index`)).toMatchObject({
      uri: "gno://work/Projects/_index.md",
      reason: "workspace-path",
      scope: "cross-collection",
      traversable: true,
    });
    expect(result.get(`${PLANNER} Roadmap`)).toMatchObject({
      uri: "gno://work/Roadmap.md",
      reason: "exact-name",
      scope: "cross-collection",
    });
    // Same-folder beats the shallower collection-root _index.md.
    expect(result.get(`${PLANNER} _index`)).toMatchObject({
      uri: "gno://ai/Agents/_index.md",
      reason: "tie-break",
      traversable: true,
    });
    // Same depth, no same-folder winner: tied, audit-only.
    expect(result.get(`${PLANNER} Shared`)).toMatchObject({
      traversable: false,
      candidates: ["gno://work/A/Shared.md", "gno://work/B/Shared.md"],
    });
    for (const unresolved of ["../../../../Escape", "Missing Note"]) {
      expect(result.get(`${PLANNER} ${unresolved}`)?.uri).toBeNull();
    }
    expect(result.get("gno://work/Roadmap.md Planner")?.uri).toBe(PLANNER);
  });

  test("a relative target resolves against the source folder but never escapes the vault", async () => {
    fixture = await openLinkWorkspaceFixture();
    await fixture.write(
      "ai",
      "Agents/Relative.md",
      "# Relative\n\n[[../Private]] [[./Planner]] [[../../../Private]] [[../../../../Private]]\n"
    );
    await fixture.sync();
    const result = outcomes(fixture.store);
    const source = "gno://ai/Agents/Relative.md";
    expect(result.get(`${source} ../Private`)?.uri).toBe("gno://ai/Private.md");
    expect(result.get(`${source} ./Planner`)?.uri).toBe(PLANNER);
    // Vault root has no Private.md; a fourth ".." would leave the vault.
    expect(result.get(`${source} ../../../Private`)?.uri).toBeNull();
    expect(result.get(`${source} ../../../../Private`)?.uri).toBeNull();
  });

  test("SQL and bulk strategies agree regardless of insertion order", async () => {
    fixture = await openLinkWorkspaceFixture();
    const db = fixture.store.getRawDb();
    const rows = db
      .query<
        {
          target_ref_norm: string;
          target_collection: string | null;
          link_type: "wiki" | "markdown";
          collection: string;
          rel_path: string;
        },
        []
      >(
        `SELECT dl.target_ref_norm, dl.target_collection, dl.link_type, d.collection, d.rel_path
         FROM doc_links dl JOIN documents d ON d.id = dl.source_doc_id ORDER BY dl.id`
      )
      .all();
    const targets: GraphLinkTarget[] = rows.map((row) => ({
      targetRefNorm: row.target_ref_norm,
      targetCollection: row.target_collection ?? row.collection,
      linkType: row.link_type,
      source: {
        collection: row.collection,
        relPath: row.rel_path,
        explicit: row.target_collection !== null,
      },
    }));
    const sql = resolveGraphLinkTargets(db, targets, "sql");
    const bulk = resolveGraphLinkTargets(db, targets, "bulk");
    expect(bulk).toEqual(sql);
    const reversed = resolveGraphLinkTargets(
      db,
      [...targets].reverse(),
      "sql"
    ).reverse();
    expect(reversed).toEqual(sql);
  });

  test("resolution inputs carry source location and explicit-prefix identity (A5)", async () => {
    fixture = await openLinkWorkspaceFixture();
    const db = fixture.store.getRawDb();
    const target = (
      relPath: string,
      explicit: boolean,
      collection = "ai"
    ): GraphLinkTarget => ({
      targetRefNorm: explicit ? "roadmap" : "_index",
      targetCollection: explicit ? "ai" : collection,
      linkType: "wiki",
      source: { collection, relPath, explicit },
    });
    const [fromAgents, fromRoot, explicitAi, implicitAi] =
      resolveGraphLinkTargets(db, [
        target("Agents/Planner.md", false),
        target("Private.md", false),
        target("Private.md", true),
        { ...target("Private.md", false), targetRefNorm: "roadmap" },
      ]);
    expect(fromAgents?.targetDocid).not.toBe(fromRoot?.targetDocid);
    expect(fromRoot?.targetCollection).toBe("ai");
    // [[ai:Roadmap]] stays collection-scoped (title match inside ai);
    // plain [[Roadmap]] prefers the file named Roadmap.md in work.
    expect(explicitAi?.targetCollection).toBe("ai");
    expect(implicitAi?.targetCollection).toBe("work");
  });
});

describe("compatibility and overrides (R4, A3, A11)", () => {
  test("explicit and unknown prefixes and non-workspace collections keep their contract", async () => {
    fixture = await openLinkWorkspaceFixture();
    const result = outcomes(fixture.store);
    expect(result.get(`${PLANNER} work:Roadmap`)).toMatchObject({
      uri: "gno://work/Roadmap.md",
      scope: "explicit-collection",
      reason: null,
    });
    expect(result.get(`${PLANNER} nope:Roadmap`)?.uri).toBeNull();
    // Collection-scoped title match, as before workspaces.
    expect(result.get("gno://plain/Home.md Roadmap")).toMatchObject({
      uri: "gno://plain/Titled.md",
      reason: null,
      scope: "same-collection",
    });
  });

  test("filename-first redirects a title match; the opt-out restores it", async () => {
    fixture = await openLinkWorkspaceFixture();
    expect(outcomes(fixture.store).get(`${PLANNER} Roadmap`)?.uri).toBe(
      "gno://work/Roadmap.md"
    );
    await fixture.reconfigure(
      fixture.collections.map((collection) =>
        collection.name === "ai"
          ? { ...collection, workspaceRoot: false }
          : collection
      )
    );
    const rows = await collectionRows(fixture.store);
    expect(rows.find((row) => row.name === "ai")?.workspaceSource).toBe(
      "disabled"
    );
    expect(outcomes(fixture.store).get(`${PLANNER} Roadmap`)).toMatchObject({
      uri: "gno://ai/Titled.md",
      reason: null,
    });
  });

  test("a configured workspaceRoot joins a collection outside any vault", async () => {
    fixture = await openLinkWorkspaceFixture();
    const plainRoot = fixture.collections.find(
      (collection) => collection.name === "plain"
    )!.path;
    await fixture.reconfigure(
      fixture.collections.map((collection) =>
        collection.name === "plain"
          ? { ...collection, workspaceRoot: plainRoot }
          : collection
      )
    );
    const rows = await collectionRows(fixture.store);
    expect(rows.find((row) => row.name === "plain")).toMatchObject({
      workspaceSource: "configured",
    });
    // A workspace of one: filename-first; no Roadmap.md in plain, so the
    // in-collection title fallback applies.
    expect(
      outcomes(fixture.store).get("gno://plain/Home.md Roadmap")
    ).toMatchObject({ uri: "gno://plain/Titled.md", reason: "title" });
  });
});

describe("filesystem identity (A7, A8, A9)", () => {
  const vaultWith = async (
    layout: Record<string, string>,
    markers: string[]
  ): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "gno-ws-fs-"));
    cleanups.push(root);
    for (const marker of markers) {
      await mkdir(join(root, marker, ".obsidian"), { recursive: true });
    }
    for (const [path, body] of Object.entries(layout)) {
      await Bun.write(join(root, path), body);
    }
    return root;
  };

  const indexCollections = async (collections: Collection[]) => {
    const store = new SqliteAdapter();
    const opened = await store.open(":memory:", "porter");
    if (!opened.ok) throw new Error(opened.error.message);
    const synced = await store.syncCollections(collections);
    if (!synced.ok) throw new Error(synced.error.message);
    await new SyncService().syncAll(collections, store);
    return store;
  };

  const coll = (name: string, path: string): Collection => ({
    name,
    path,
    pattern: "**/*.md",
    include: [],
    exclude: [],
  });

  test("a nested vault is its own workspace, even inside an outer collection", async () => {
    const root = await vaultWith(
      {
        "Top.md": "# Top\n\n[[Deep]]\n",
        "inner/Deep.md": "# Deep\n\n[[Top]] [[Sibling]]\n",
        "inner/sub/Sibling.md": "# Sibling\n\n[[Deep]]\n",
      },
      [".", "inner"]
    );
    const store = await indexCollections([
      coll("outer", root),
      coll("nested", join(root, "inner", "sub")),
    ]);
    try {
      const rows = await collectionRows(store);
      expect(rows.find((row) => row.name === "outer")?.workspaceNested).toEqual(
        ["inner"]
      );
      const result = outcomes(store);
      // Outer vault never resolves into the nested vault, nor out of it.
      expect(result.get("gno://outer/Top.md Deep")?.uri).toBeNull();
      expect(result.get("gno://outer/inner/Deep.md Top")?.uri).toBeNull();
      // Inside the nested vault, the collection nested in it is a member;
      // its Sibling.md is the same file as outer's row, so outer keeps its own.
      expect(result.get("gno://outer/inner/Deep.md Sibling")).toMatchObject({
        uri: "gno://outer/inner/sub/Sibling.md",
        traversable: true,
      });
      expect(result.get("gno://nested/Sibling.md Deep")).toMatchObject({
        uri: "gno://outer/inner/Deep.md",
        scope: "cross-collection",
      });
    } finally {
      await store.close();
    }
  });

  test("symlinked roots use real paths; NFD file names match NFC links", async () => {
    const nfd = "Café";
    const root = await vaultWith(
      {
        "real/A.md": `# A\n\n[[B]] [[${nfd.normalize("NFC")}]]\n`,
        "other/B.md": "# B\n",
        [`other/${nfd}.md`]: "# Accent\n",
      },
      ["."]
    );
    const link = join(await mkdtemp(join(tmpdir(), "gno-ws-link-")), "alias");
    cleanups.push(join(link, ".."));
    await symlink(join(root, "real"), link);
    const store = await indexCollections([
      coll("linked", link),
      coll("other", join(root, "other")),
    ]);
    try {
      const rows = await collectionRows(store);
      const linked = rows.find((row) => row.name === "linked");
      expect(linked?.workspaceSource).toBe("detected");
      expect(linked?.realPath?.endsWith("real")).toBe(true);
      const result = outcomes(store);
      expect(result.get("gno://linked/A.md B")?.uri).toBe("gno://other/B.md");
      const accent = result.get(`gno://linked/A.md ${nfd.normalize("NFC")}`);
      expect(decodeURIComponent(accent?.uri ?? "").normalize("NFC")).toBe(
        `gno://other/${nfd.normalize("NFC")}.md`
      );
    } finally {
      await store.close();
    }
  });

  test("one file indexed twice is one source, not an ambiguity", async () => {
    const root = await vaultWith(
      {
        "Spaces/AI/Note.md": "# Note\n",
        "Spaces/Work/Linker.md": "# Linker\n\n[[Note]]\n",
        "Spaces/Work/Copy.md": "# Note\n",
      },
      ["."]
    );
    const store = await indexCollections([
      coll("vault", root),
      coll("ai", join(root, "Spaces", "AI")),
      coll("work", join(root, "Spaces", "Work")),
    ]);
    try {
      const result = outcomes(store);
      // Two rows of Spaces/AI/Note.md (vault + ai) collapse to one source.
      const fromWork = result.get("gno://work/Linker.md Note");
      expect(fromWork?.traversable).toBe(true);
      expect(fromWork?.uri).toBe("gno://ai/Note.md");
      // The same file from the vault collection's view prefers its own row.
      expect(result.get("gno://vault/Spaces/Work/Linker.md Note")?.uri).toBe(
        "gno://vault/Spaces/AI/Note.md"
      );
    } finally {
      await store.close();
    }
  });

  test("moving the vault marker changes membership on the next config sync", async () => {
    fixture = await openLinkWorkspaceFixture();
    await rename(
      join(fixture.vault, ".obsidian"),
      join(fixture.vault, "Spaces", "AI", ".obsidian")
    );
    await fixture.reconfigure(fixture.collections);
    const rows = await collectionRows(fixture.store);
    expect(rows.find((row) => row.name === "work")?.workspaceSource).toBe(
      "none"
    );
    expect(outcomes(fixture.store).get(`${PLANNER} Roadmap`)?.uri).toBe(
      "gno://ai/Titled.md"
    );
  });
});
