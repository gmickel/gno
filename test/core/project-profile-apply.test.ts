import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary-directory lifecycle without Bun equivalents.
import { mkdir, mkdtemp, readdir, realpath } from "node:fs/promises";
// node:os provides the temporary root.
import { tmpdir } from "node:os";
// node:path provides fixture paths; Bun has no path utilities.
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { getIndexDbPath } from "../../src/app/constants";
import { createDefaultConfig } from "../../src/config/defaults";
import { loadConfigFromPath } from "../../src/config/loader";
import { saveConfigToPath } from "../../src/config/saver";
import {
  applyProjectProfile,
  type ProjectProfileApplyReceipt,
} from "../../src/core/project-profile-apply";
import { SqliteAdapter as RealSqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const tempRoots: string[] = [];

const PROFILE = `
schemaVersion: "1.0"
collection:
  name: notes
  root: .
  include: ["**/*.md", "docs/**/*.txt"]
  exclude: [node_modules]
  languageHint: en
  modelPreset: slim-tuned
contexts:
  - text: Project context.
contentTypes:
  people:
    prefixes: [people]
    preset: person
affinityDefaults:
  enabled: true
  contribution: 0.02
recommendedCapabilities: [workspace.read]
`;

interface StoreProbe {
  store: SqliteAdapter;
  collectionSyncs: Config["collections"][];
  contextSyncs: Config["contexts"][];
}

function createStoreProbe(): StoreProbe {
  const collectionSyncs: Config["collections"][] = [];
  const contextSyncs: Config["contexts"][] = [];
  return {
    store: {
      syncCollections: async (collections: Config["collections"]) => {
        collectionSyncs.push(structuredClone(collections));
        return { ok: true, value: undefined };
      },
      syncContexts: async (contexts: Config["contexts"]) => {
        contextSyncs.push(structuredClone(contexts));
        return { ok: true, value: undefined };
      },
      upsertCollections: async (collections: Config["collections"]) => {
        collectionSyncs.push(structuredClone(collections));
        return { ok: true, value: undefined };
      },
      upsertContexts: async (contexts: Config["contexts"]) => {
        contextSyncs.push(structuredClone(contexts));
        return { ok: true, value: undefined };
      },
    } as unknown as SqliteAdapter,
    collectionSyncs,
    contextSyncs,
  };
}

async function createFixture(label: string): Promise<{
  root: string;
  project: string;
  profilePath: string;
  configPath: string;
  dataDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `gno-profile-apply-${label}-`));
  tempRoots.push(root);
  const project = join(root, "project");
  const profilePath = join(project, ".gno", "index.yml");
  await mkdir(join(project, ".gno"), { recursive: true });
  await Bun.write(profilePath, PROFILE);
  const canonicalProject = await realpath(project);
  return {
    root,
    project: canonicalProject,
    profilePath: join(canonicalProject, ".gno", "index.yml"),
    configPath: join(root, "runtime", "config", "index.yml"),
    dataDir: join(root, "runtime", "data"),
  };
}

async function readConfig(path: string): Promise<Config> {
  const loaded = await loadConfigFromPath(path);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error(loaded.error.message);
  return loaded.value;
}

afterEach(async () => {
  for (const path of tempRoots.splice(0)) {
    await safeRm(path);
  }
});

describe("applyProjectProfile", () => {
  test("creates external runtime state and converges to deterministic unchanged receipts", async () => {
    const fixture = await createFixture("idempotent");
    const profileBefore = await Bun.file(fixture.profilePath).text();
    const store = createStoreProbe();
    const options = {
      profileYaml: PROFILE,
      profileRoot: fixture.project,
      configPath: fixture.configPath,
      dataDir: fixture.dataDir,
      store: store.store,
    };

    const first = await applyProjectProfile(options);
    const configBytesAfterFirst = await Bun.file(fixture.configPath).text();
    const second = await applyProjectProfile(options);
    const configBytesAfterSecond = await Bun.file(fixture.configPath).text();
    const third = await applyProjectProfile(options);

    expect(first.ok && first.receipt.status).toBe("applied");
    expect(second.ok && second.receipt.status).toBe("unchanged");
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);
    if (!(second.ok && third.ok)) return;
    expect(third.receipt).toEqual(second.receipt);
    expect(configBytesAfterSecond).toBe(configBytesAfterFirst);
    expect(second.ok && second.receipt.diff.status).toBe("in_sync");
    expect(second.ok && second.receipt.pendingIndexing).toEqual([]);
    expect(first.ok && first.receiptPath.startsWith(fixture.dataDir)).toBe(
      true
    );
    expect(await Bun.file(fixture.profilePath).text()).toBe(profileBefore);
    expect(await readdir(join(fixture.project, ".gno"))).toEqual(["index.yml"]);

    const config = await readConfig(fixture.configPath);
    expect(config.collections).toHaveLength(1);
    expect(config.collections[0]).toMatchObject({
      name: "notes",
      path: fixture.project,
      pattern: "{**/*.md,docs/**/*.txt}",
      include: [],
      exclude: [".gno", "node_modules"],
      languageHint: "en",
    });
    expect(config.collections[0]?.models?.embed).toStartWith("hf:");
    expect(config.contexts).toContainEqual({
      scopeType: "collection",
      scopeKey: "notes:",
      text: "Project context.",
    });
    expect(config.projectProfileBindings).toEqual([
      {
        path: fixture.profilePath,
        fingerprint: first.ok ? first.receipt.profile.fingerprint : "",
        collection: "notes",
      },
    ]);
    expect(config.projectAffinity).toEqual({
      enabled: true,
      contribution: 0.03,
    });
    expect(first.ok && first.receipt.resources).toContainEqual({
      kind: "profile_binding",
      id: "notes",
      disposition: "created",
      pendingIndexing: false,
    });
    expect(first.ok && first.receipt.resources).toContainEqual({
      kind: "project_affinity",
      id: "profile",
      disposition: "skipped",
      pendingIndexing: false,
    });
    expect(store.collectionSyncs).toHaveLength(3);
    expect(store.contextSyncs).toHaveLength(3);
  });

  test("preserves omitted and stale resources instead of deleting implicitly", async () => {
    const fixture = await createFixture("preserve");
    const config = createDefaultConfig();
    config.collections = [
      {
        name: "legacy-notes",
        path: fixture.project,
        pattern: "**/*",
        include: [],
        exclude: [],
      },
      {
        name: "archive",
        path: join(fixture.root, "archive"),
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ];
    config.contexts = [
      {
        scopeType: "collection",
        scopeKey: "notes:",
        text: "Locally managed context.",
      },
    ];
    config.contentTypes = [
      { id: "local", prefixes: ["local"], preset: "person" },
    ];
    await saveConfigToPath(config, fixture.configPath);
    const store = createStoreProbe();

    const applied = await applyProjectProfile({
      profileYaml: PROFILE,
      profileRoot: fixture.project,
      configPath: fixture.configPath,
      dataDir: fixture.dataDir,
      store: store.store,
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.receipt.resources).toContainEqual({
      kind: "stale_mapping",
      id: "legacy-notes",
      disposition: "skipped",
      pendingIndexing: false,
    });
    const saved = await readConfig(fixture.configPath);
    expect(
      saved.collections.map((collection) => collection.name).sort()
    ).toEqual(["archive", "legacy-notes", "notes"]);
    expect(saved.contexts.map((context) => context.text)).toContain(
      "Locally managed context."
    );
    expect(saved.contentTypes?.map((rule) => rule.id).sort()).toEqual([
      "local",
      "people",
    ]);

    const reduced = await applyProjectProfile({
      profileYaml:
        'schemaVersion: "1.0"\ncollection: { name: notes, root: . }\n',
      profileRoot: fixture.project,
      configPath: fixture.configPath,
      dataDir: fixture.dataDir,
      store: store.store,
    });
    expect(reduced.ok).toBe(true);
    expect(reduced.ok && reduced.receipt.status).toBe("applied");
    const afterRemoval = await readConfig(fixture.configPath);
    expect(afterRemoval.collections.map((item) => item.name).sort()).toEqual([
      "archive",
      "legacy-notes",
      "notes",
    ]);
    expect(afterRemoval.contexts).toEqual(saved.contexts);
    expect(afterRemoval.contentTypes).toEqual(saved.contentTypes);
    expect(afterRemoval.projectProfileBindings).toEqual([
      {
        path: fixture.profilePath,
        fingerprint: reduced.ok ? reduced.receipt.profile.fingerprint : "",
        collection: "notes",
      },
    ]);
    const unchangedReduced = await applyProjectProfile({
      profileYaml:
        'schemaVersion: "1.0"\ncollection: { name: notes, root: . }\n',
      profileRoot: fixture.project,
      configPath: fixture.configPath,
      dataDir: fixture.dataDir,
      store: store.store,
    });
    expect(unchangedReduced.ok && unchangedReduced.receipt.status).toBe(
      "unchanged"
    );
  });

  test("rebinds a renamed profile without deleting its previous collection", async () => {
    const fixture = await createFixture("rename-binding");
    const store = createStoreProbe();
    const first = await applyProjectProfile({
      profileYaml: PROFILE,
      profileRoot: fixture.project,
      configPath: fixture.configPath,
      dataDir: fixture.dataDir,
      store: store.store,
    });
    expect(first.ok).toBe(true);

    const renamedYaml = PROFILE.replace("name: notes", "name: team-notes");
    const renamed = await applyProjectProfile({
      profileYaml: renamedYaml,
      profileRoot: fixture.project,
      configPath: fixture.configPath,
      dataDir: fixture.dataDir,
      store: store.store,
    });
    expect(renamed.ok && renamed.receipt.status).toBe("applied");
    if (!renamed.ok) return;
    expect(renamed.receipt.resources).toContainEqual({
      kind: "profile_binding",
      id: "team-notes",
      disposition: "updated",
      pendingIndexing: false,
    });
    const saved = await readConfig(fixture.configPath);
    expect(
      saved.collections.map((collection) => collection.name).sort()
    ).toEqual(["notes", "team-notes"]);
    expect(saved.projectProfileBindings).toEqual([
      {
        path: fixture.profilePath,
        fingerprint: renamed.receipt.profile.fingerprint,
        collection: "team-notes",
      },
    ]);
  });

  test("additively projects into a real store without deleting DB-only indexed state", async () => {
    const fixture = await createFixture("real-store-preserve");
    const store = new RealSqliteAdapter();
    const dbPath = getIndexDbPath("default", {
      config: join(fixture.root, "runtime", "config"),
      data: fixture.dataDir,
      cache: join(fixture.root, "runtime", "cache"),
    });
    await mkdir(fixture.dataDir, { recursive: true });
    const opened = await store.open(dbPath, "unicode61");
    expect(opened.ok).toBe(true);
    expect(
      (
        await store.syncCollections([
          {
            name: "recovery",
            path: join(fixture.root, "recovery"),
            pattern: "**/*",
            include: [],
            exclude: [],
          },
        ])
      ).ok
    ).toBe(true);
    expect(
      (
        await store.syncContexts([
          {
            scopeType: "collection",
            scopeKey: "recovery:",
            text: "Recovery context",
          },
        ])
      ).ok
    ).toBe(true);
    const document = await store.upsertDocument({
      collection: "recovery",
      relPath: "evidence.md",
      sourceHash: "a".repeat(64),
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 24,
      sourceMtime: "2026-07-24T00:00:00.000Z",
      title: "Recovery evidence",
      mirrorHash: "b".repeat(64),
      converterId: "native/markdown",
      converterVersion: "1.0.0",
      contentTypeSource: "default",
    });
    expect(document.ok).toBe(true);

    try {
      const applied = await applyProjectProfile({
        profileYaml: PROFILE.replace(
          "  - text: Project context.",
          "  - text: Project context.\n  - text: Secondary context."
        ),
        profileRoot: fixture.project,
        configPath: fixture.configPath,
        dataDir: fixture.dataDir,
        store,
        runtimePaths: [{ label: "Index database", path: dbPath }],
      });
      expect(applied.ok).toBe(true);

      const collections = await store.getCollections();
      expect(collections.ok).toBe(true);
      if (collections.ok) {
        expect(collections.value.map((item) => item.name).sort()).toEqual([
          "notes",
          "recovery",
        ]);
      }
      const contexts = await store.getContexts();
      expect(contexts.ok).toBe(true);
      if (contexts.ok) {
        expect(
          contexts.value
            .filter((item) => item.scopeKey === "notes:")
            .map((item) => item.text)
            .sort()
        ).toEqual(["Project context.", "Secondary context."]);
        expect(contexts.value).toContainEqual(
          expect.objectContaining({
            scopeKey: "recovery:",
            text: "Recovery context",
          })
        );
      }
      const preserved = await store.getDocument("recovery", "evidence.md");
      expect(preserved.ok && preserved.value?.title).toBe("Recovery evidence");
    } finally {
      await store.close();
    }
  });

  test("repairs a stale same-name root while retaining the old index identity", async () => {
    const fixture = await createFixture("repair-root");
    const config = createDefaultConfig();
    config.collections = [
      {
        name: "notes",
        path: join(fixture.root, "old-root"),
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ];
    await saveConfigToPath(config, fixture.configPath);

    const result = await applyProjectProfile({
      profileYaml: PROFILE,
      profileRoot: fixture.project,
      configPath: fixture.configPath,
      dataDir: fixture.dataDir,
      store: createStoreProbe().store,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.diff.staleMappings).toContainEqual({
      collection: "notes",
      reason: "root_changed",
      choices: ["repair", "remove_explicitly"],
    });
    expect(result.receipt.resources).toContainEqual({
      kind: "collection",
      id: "notes",
      disposition: "updated",
      pendingIndexing: true,
    });
    expect((await readConfig(fixture.configPath)).collections[0]?.path).toBe(
      fixture.project
    );
  });

  test("resumes after interruption and serializes concurrent apply calls", async () => {
    const fixture = await createFixture("recovery");
    const store = createStoreProbe();
    const interrupted = await applyProjectProfile({
      profileYaml: PROFILE,
      profileRoot: fixture.project,
      configPath: fixture.configPath,
      dataDir: fixture.dataDir,
      store: store.store,
      failureInjection: "after_config_save",
    });
    expect(interrupted).toMatchObject({
      ok: false,
      error: { code: "CONFIG_SAVE_FAILED" },
    });
    expect((await readConfig(fixture.configPath)).collections).toHaveLength(1);
    expect(store.collectionSyncs).toHaveLength(0);

    const receipts: ProjectProfileApplyReceipt[] = [];
    let activeReceiptWrites = 0;
    let maxActiveReceiptWrites = 0;
    const concurrentOptions = {
      profileYaml: PROFILE,
      profileRoot: fixture.project,
      configPath: fixture.configPath,
      dataDir: fixture.dataDir,
      store: store.store,
      receiptWriter: async (receipt: ProjectProfileApplyReceipt) => {
        activeReceiptWrites += 1;
        maxActiveReceiptWrites = Math.max(
          maxActiveReceiptWrites,
          activeReceiptWrites
        );
        await Bun.sleep(5);
        receipts.push(receipt);
        activeReceiptWrites -= 1;
      },
    };
    const results = await Promise.all([
      applyProjectProfile(concurrentOptions),
      applyProjectProfile(concurrentOptions),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(receipts.map((receipt) => receipt.status)).toEqual([
      "unchanged",
      "unchanged",
    ]);
    expect(maxActiveReceiptWrites).toBe(1);
    expect((await readConfig(fixture.configPath)).collections).toHaveLength(1);
    expect(store.collectionSyncs).toHaveLength(2);
  });

  test("rejects runtime output paths inside the project before mutation", async () => {
    const fixture = await createFixture("overlap");
    const store = createStoreProbe();
    const result = await applyProjectProfile({
      profileYaml: PROFILE,
      profileRoot: fixture.project,
      configPath: join(fixture.project, ".gno", "runtime-config.yml"),
      dataDir: join(fixture.project, ".gno", "runtime"),
      store: store.store,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "RUNTIME_PATH_OVERLAP" },
    });
    expect(store.collectionSyncs).toHaveLength(0);
    expect(await readdir(join(fixture.project, ".gno"))).toEqual(["index.yml"]);
  });
});
