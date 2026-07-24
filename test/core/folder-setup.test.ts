import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary directory and symlink operations without Bun equivalents.
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
// node:os has no Bun equivalent.
import { tmpdir } from "node:os";
// node:path has no Bun equivalent.
import { join } from "node:path";

import type { Collection, Config } from "../../src/config";
import type {
  FolderSetupFailurePoint,
  FolderSetupOptions,
} from "../../src/core/folder-setup";

import { createDefaultConfig, loadConfig, saveConfig } from "../../src/config";
import { setupFolder } from "../../src/core/folder-setup";
import {
  getSetupReceiptPath,
  serializeSetupReceipt,
  type SetupStageName,
} from "../../src/core/setup-receipt";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const FIXED_NOW = new Date("2026-07-24T10:00:00.000Z");
const tempRoots: string[] = [];

interface Harness {
  temp: string;
  folder: string;
  dataDir: string;
  configPath: string;
  store: SqliteAdapter;
  options: FolderSetupOptions;
}

function collection(name: string, path: string): Collection {
  return {
    name,
    path,
    pattern: "**/*",
    include: [],
    exclude: [],
  };
}

async function createHarness(
  label: string,
  configMutator?: (config: Config, temp: string) => Promise<void> | void
): Promise<Harness> {
  const temp = await mkdtemp(join(tmpdir(), `gno-folder-setup-${label}-`));
  tempRoots.push(temp);
  const folder = join(temp, "docs");
  const dataDir = join(temp, "data");
  const configPath = join(temp, "config", "index.yml");
  await Promise.all([
    mkdir(folder, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
  ]);
  const config = createDefaultConfig();
  config.ftsTokenizer = "unicode61";
  await configMutator?.(config, temp);
  const saved = await saveConfig(config, configPath);
  expect(saved.ok).toBe(true);

  const store = new SqliteAdapter();
  const opened = await store.open(
    join(dataDir, "index-default.sqlite"),
    "unicode61"
  );
  expect(opened.ok).toBe(true);
  return {
    temp,
    folder,
    dataDir,
    configPath,
    store,
    options: {
      folder,
      store,
      configPath,
      dataDir,
      now: () => FIXED_NOW,
    },
  };
}

async function configuredCollections(
  configPath: string
): Promise<Collection[]> {
  const loaded = await loadConfig(configPath);
  expect(loaded.ok).toBe(true);
  return loaded.ok ? loaded.value.collections : [];
}

async function closeHarness(harness: Harness): Promise<void> {
  await harness.store.close();
}

afterEach(async () => {
  for (const path of tempRoots.splice(0)) {
    await safeRm(path);
  }
});

describe("verified folder setup", () => {
  test("creates one collection, indexes content, proves BM25, and writes a private canonical receipt", async () => {
    const harness = await createHarness("success");
    try {
      await writeFile(
        join(harness.folder, "launch.md"),
        "# Launch\n\nProject Atlas reaches orbit on Friday."
      );
      const result = await setupFolder(harness.options);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.receipt).toMatchObject({
        schemaVersion: "1.0",
        status: "completed",
        collection: {
          name: "docs",
          disposition: "created",
          path: await realpath(harness.folder),
        },
        stages: {
          preflight: { status: "passed" },
          config_saved: { status: "passed" },
          store_synced: { status: "passed" },
          lexical_indexed: { status: "passed" },
          lexical_proved: { status: "passed" },
          completed: { status: "passed" },
        },
        activation: {
          ready: true,
          collection: "docs",
          stages: { lexical: { status: "passed" } },
        },
      });
      expect(result.receipt.activation?.evidence.resultUri).toMatch(
        /^gno:\/\/docs\/launch\.md$/
      );
      expect(await configuredCollections(harness.configPath)).toHaveLength(1);
      const docs = await harness.store.listDocuments("docs");
      expect(docs.ok && docs.value).toHaveLength(1);

      const expectedPath = getSetupReceiptPath({
        dataDir: harness.dataDir,
        indexName: "default",
        folderRealpath: await realpath(harness.folder),
      });
      expect(result.receipt.paths.receipt).toBe(expectedPath);
      expect(await Bun.file(expectedPath).text()).toBe(
        serializeSetupReceipt(result.receipt)
      );
      if (process.platform !== "win32") {
        expect((await stat(expectedPath)).mode & 0o777).toBe(0o600);
        expect((await stat(join(expectedPath, ".."))).mode & 0o777).toBe(0o700);
      }
      assertValid(result.receipt, await loadSchema("setup-receipt"));
      expect(JSON.stringify(result.receipt)).not.toContain(
        "Project Atlas reaches orbit"
      );
    } finally {
      await closeHarness(harness);
    }
  });

  test("reuses canonical symlink identity without rewriting config", async () => {
    const harness = await createHarness("reuse", async (config, temp) => {
      config.collections.push(collection("existing", join(temp, "docs")));
    });
    try {
      await writeFile(
        join(harness.folder, "note.md"),
        "Reusable lexical proof"
      );
      const link = join(harness.temp, "linked-docs");
      await symlink(harness.folder, link, "dir");
      const before = await Bun.file(harness.configPath).text();

      const result = await setupFolder({
        ...harness.options,
        folder: link,
      });

      expect(result.ok).toBe(true);
      expect(result.receipt?.collection).toMatchObject({
        name: "existing",
        disposition: "reused",
        path: await realpath(harness.folder),
      });
      expect(await Bun.file(harness.configPath).text()).toBe(before);
      expect(await configuredCollections(harness.configPath)).toHaveLength(1);
    } finally {
      await closeHarness(harness);
    }
  });

  test("uses deterministic derived suffixes and rejects explicit conflicts", async () => {
    const harness = await createHarness("collision", async (config, temp) => {
      const other = join(temp, "other", "docs");
      await mkdir(other, { recursive: true });
      config.collections.push(collection("docs", other));
    });
    try {
      await writeFile(
        join(harness.folder, "note.md"),
        "Collision suffix proof"
      );
      const derived = await setupFolder(harness.options);
      expect(derived.ok).toBe(true);
      expect(derived.receipt?.collection.name).toBe("docs-2");

      const secondRoot = join(harness.temp, "second-root");
      await mkdir(secondRoot, { recursive: true });
      await writeFile(join(secondRoot, "note.md"), "Explicit collision proof");
      const explicit = await setupFolder({
        ...harness.options,
        folder: secondRoot,
        name: "docs",
      });
      expect(explicit).toMatchObject({
        ok: false,
        error: { code: "collection_name_conflict" },
      });
    } finally {
      await closeHarness(harness);
    }
  });

  test("fails closed for nested roots and explicit-name disagreement", async () => {
    const harness = await createHarness("overlap", async (config, temp) => {
      config.collections.push(collection("parent", temp));
    });
    try {
      await writeFile(join(harness.folder, "note.md"), "Nested root proof");
      const nested = await setupFolder(harness.options);
      expect(nested).toMatchObject({
        ok: false,
        error: { code: "collection_overlap" },
      });

      const exactHarness = await createHarness(
        "explicit-disagreement",
        async (config, temp) => {
          config.collections.push(collection("canonical", join(temp, "docs")));
        }
      );
      try {
        await writeFile(
          join(exactHarness.folder, "note.md"),
          "Explicit name mismatch"
        );
        const mismatch = await setupFolder({
          ...exactHarness.options,
          name: "renamed",
        });
        expect(mismatch).toMatchObject({
          ok: false,
          error: { code: "collection_name_conflict" },
        });
      } finally {
        await closeHarness(exactHarness);
      }
    } finally {
      await closeHarness(harness);
    }
  });

  test("rejects empty, unsupported-only, secret-risk, missing, file, and dangerous inputs before config mutation", async () => {
    const harness = await createHarness("unsafe");
    try {
      const initialConfig = await Bun.file(harness.configPath).text();
      expect(await setupFolder(harness.options)).toMatchObject({
        ok: false,
        error: { code: "empty_folder" },
      });

      await writeFile(join(harness.folder, "archive.bin"), "unsupported");
      expect(await setupFolder(harness.options)).toMatchObject({
        ok: false,
        error: { code: "unsupported_only" },
      });

      await writeFile(join(harness.folder, "note.md"), "Safe document");
      await writeFile(join(harness.folder, ".env.local"), "API_KEY=value");
      expect(await setupFolder(harness.options)).toMatchObject({
        ok: false,
        error: { code: "secret_risk" },
      });
      expect(await Bun.file(harness.configPath).text()).toBe(initialConfig);

      const missing = await setupFolder({
        ...harness.options,
        folder: join(harness.temp, "missing"),
      });
      expect(missing).toMatchObject({
        ok: false,
        error: { code: "folder_not_found" },
        receipt: null,
      });
      const filePath = join(harness.temp, "file.md");
      await writeFile(filePath, "not a folder");
      expect(
        await setupFolder({ ...harness.options, folder: filePath })
      ).toMatchObject({
        ok: false,
        error: { code: "folder_not_directory" },
      });
      expect(
        await setupFolder({ ...harness.options, folder: "/" })
      ).toMatchObject({
        ok: false,
        error: { code: "dangerous_root" },
      });
    } finally {
      await closeHarness(harness);
    }
  });

  test("explicit exclusion or authorization resolves secret risk without persisting secret names", async () => {
    const harness = await createHarness("secret-authorized");
    try {
      await writeFile(join(harness.folder, "note.md"), "Authorized safe proof");
      await writeFile(join(harness.folder, ".env"), "TOKEN=value");
      const result = await setupFolder({
        ...harness.options,
        exclude: [".env"],
      });
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result.receipt)).not.toContain("TOKEN=value");
      expect(result.receipt?.input.excludes).toContain(".env");
    } finally {
      await closeHarness(harness);
    }
  });

  test("rejects a supported file that cannot produce a lexical proof", async () => {
    const harness = await createHarness("no-lexical-corpus");
    try {
      await writeFile(join(harness.folder, "empty.md"), "");
      const result = await setupFolder(harness.options);
      expect(result).toMatchObject({
        ok: false,
        error: { code: "lexical_proof_failed" },
        receipt: {
          status: "failed",
          activation: {
            ready: false,
            stages: { lexical: { code: "no_probe_term" } },
          },
        },
      });
    } finally {
      await closeHarness(harness);
    }
  });

  test.skipIf(process.platform === "win32")(
    "rejects an unreadable folder before receipt identity",
    async () => {
      const harness = await createHarness("unreadable");
      try {
        await writeFile(join(harness.folder, "note.md"), "Unreadable proof");
        await chmod(harness.folder, 0o000);
        const result = await setupFolder(harness.options);
        expect(result).toMatchObject({
          ok: false,
          error: { code: "folder_unreadable" },
          receipt: null,
        });
      } finally {
        await chmod(harness.folder, 0o700);
        await closeHarness(harness);
      }
    }
  );

  test("every interruption checkpoint resumes without duplicate config or content", async () => {
    const checkpoints: FolderSetupFailurePoint[] = [
      "after_config_save",
      "after_store_sync",
      "after_lexical_index",
      "after_lexical_proof",
    ];
    const interruptionStages: Record<
      FolderSetupFailurePoint,
      { completed: SetupStageName; next: SetupStageName }
    > = {
      after_config_save: { completed: "config_saved", next: "store_synced" },
      after_store_sync: { completed: "store_synced", next: "lexical_indexed" },
      after_lexical_index: {
        completed: "lexical_indexed",
        next: "lexical_proved",
      },
      after_lexical_proof: {
        completed: "lexical_proved",
        next: "completed",
      },
    };

    for (const checkpoint of checkpoints) {
      const harness = await createHarness(`resume-${checkpoint}`);
      try {
        await writeFile(
          join(harness.folder, "note.md"),
          `Deterministic recovery proof for ${checkpoint}`
        );
        const interrupted = await setupFolder({
          ...harness.options,
          failureInjection: checkpoint,
        });
        expect(interrupted).toMatchObject({
          ok: false,
          error: { code: "injected_failure" },
          receipt: {
            status: "failed",
            failure: { stage: interruptionStages[checkpoint].completed },
          },
        });
        expect(
          interrupted.receipt?.stages[interruptionStages[checkpoint].completed]
            .status
        ).toBe("passed");
        expect(
          interrupted.receipt?.stages[interruptionStages[checkpoint].next]
            .status
        ).toBe("pending");
        assertValid(interrupted.receipt, await loadSchema("setup-receipt"));
        const configAfterFailure = await Bun.file(harness.configPath).text();

        const resumed = await setupFolder(harness.options);
        expect(resumed.ok).toBe(true);
        expect(await Bun.file(harness.configPath).text()).toBe(
          configAfterFailure
        );
        expect(await configuredCollections(harness.configPath)).toHaveLength(1);
        const docs = await harness.store.listDocuments(
          resumed.receipt?.collection.name ?? "docs"
        );
        expect(docs.ok && docs.value).toHaveLength(1);
        if (checkpoint === "after_lexical_proof") {
          expect(interrupted.receipt?.activation?.ready).toBe(true);
        }
      } finally {
        await closeHarness(harness);
      }
    }
  });

  test("concurrent setup calls converge on one config entry and document", async () => {
    const harness = await createHarness("concurrent");
    try {
      await writeFile(
        join(harness.folder, "note.md"),
        "Concurrent setup convergence proof"
      );
      const [left, right] = await Promise.all([
        setupFolder(harness.options),
        setupFolder(harness.options),
      ]);
      expect(left.ok).toBe(true);
      expect(right.ok).toBe(true);
      expect(await configuredCollections(harness.configPath)).toHaveLength(1);
      const documents = await harness.store.listDocuments("docs");
      expect(documents.ok && documents.value).toHaveLength(1);
    } finally {
      await closeHarness(harness);
    }
  });
});
