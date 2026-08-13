/** Live `gno serve` watcher smoke with real SQLite and lexical search. */

// node:fs/promises — structural temp fixture operations have no Bun equivalent.
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
// node:os — Bun has no temp-directory helper.
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities.
import { join } from "node:path";

import { saveConfigToPath } from "../src/config/saver";
import { startBackgroundRuntime } from "../src/serve/background-runtime";
import { safeRm } from "../test/helpers/cleanup";

const POLL_TIMEOUT_MS = 10_000;

async function freePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("Unable to allocate loopback port");
  return port;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = POLL_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(50);
  }
}

async function search(baseUrl: string, query: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, limit: 10, collection: "notes" }),
  });
  if (!response.ok) {
    throw new Error(
      `Search ${query} failed: ${response.status} ${await response.text()}`
    );
  }
  return JSON.stringify(await response.json());
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gno-watch-smoke-"));
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  const cacheDir = join(root, "cache");
  const collectionDir = join(root, "notes");
  const configPath = join(configDir, "index.yml");
  const index = "watcher-smoke";
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const originalEnv = {
    GNO_CONFIG_DIR: process.env.GNO_CONFIG_DIR,
    GNO_DATA_DIR: process.env.GNO_DATA_DIR,
    GNO_CACHE_DIR: process.env.GNO_CACHE_DIR,
    GNO_OFFLINE: process.env.GNO_OFFLINE,
  };
  let child: ReturnType<typeof Bun.spawn> | null = null;

  try {
    await mkdir(join(collectionDir, "nested", "deep"), { recursive: true });
    await Bun.write(join(collectionDir, "atomic.md"), "atomic-old-token");
    await Bun.write(join(collectionDir, "plain.md"), "plain-old-token");
    await Bun.write(
      join(collectionDir, "sibling.md"),
      "untouched-sibling-token"
    );
    await Bun.write(
      join(collectionDir, "nested", "deep", "delete.md"),
      "nested-delete-token"
    );
    const saved = await saveConfigToPath(
      {
        version: "1.0",
        ftsTokenizer: "unicode61",
        collections: [
          {
            name: "notes",
            path: collectionDir,
            pattern: "**/*.md",
            include: [],
            exclude: [],
          },
        ],
        contexts: [],
      },
      configPath
    );
    if (!saved.ok) throw new Error(saved.error.message);

    process.env.GNO_CONFIG_DIR = configDir;
    process.env.GNO_DATA_DIR = dataDir;
    process.env.GNO_CACHE_DIR = cacheDir;
    process.env.GNO_OFFLINE = "1";
    const seed = await startBackgroundRuntime({
      configPath,
      index,
      offline: true,
    });
    if (!seed.success) throw new Error(seed.error);
    try {
      await seed.runtime.syncAll({ triggerEmbed: false });
    } finally {
      await seed.runtime.dispose();
    }

    child = Bun.spawn(
      [
        process.execPath,
        "src/index.ts",
        "--config",
        configPath,
        "--index",
        index,
        "serve",
        "--port",
        String(port),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: "production", GNO_OFFLINE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    await waitFor(async () => {
      try {
        const response = await fetch(`${baseUrl}/api/resident/status`);
        await response.body?.cancel();
        return response.ok;
      } catch {
        return false;
      }
    }, "serve readiness");

    const replacement = join(collectionDir, ".atomic.md.tmp");
    await Bun.write(replacement, "atomic-new-token");
    await rename(replacement, join(collectionDir, "atomic.md"));
    const responsiveStartedAt = performance.now();
    const status = await fetch(`${baseUrl}/api/resident/status`);
    await status.body?.cancel();
    const responsiveMs = performance.now() - responsiveStartedAt;
    if (!status.ok || responsiveMs > 1_000) {
      throw new Error(
        `Unrelated status request was not responsive: ${responsiveMs.toFixed(1)}ms`
      );
    }
    await waitFor(
      async () =>
        (await search(baseUrl, "atomic-new-token")).includes("atomic.md"),
      "dot-temp atomic replacement visibility"
    );

    const plainReplacement = join(collectionDir, "plain.md.tmp");
    await Bun.write(plainReplacement, "plain-new-token");
    await rename(plainReplacement, join(collectionDir, "plain.md"));
    await waitFor(
      async () =>
        (await search(baseUrl, "plain-new-token")).includes("plain.md"),
      "plain-temp atomic replacement visibility"
    );

    await rm(join(collectionDir, "nested"), { recursive: true });
    await waitFor(
      async () =>
        !(await search(baseUrl, "nested-delete-token")).includes("delete.md"),
      "nested deletion visibility"
    );
    const sibling = await search(baseUrl, "untouched-sibling-token");
    if (!sibling.includes("sibling.md")) {
      throw new Error("Untouched sibling disappeared from lexical search");
    }

    console.log(
      JSON.stringify({
        platform: process.platform,
        bun: Bun.version,
        mode: "serve",
        dotTempAtomicReplacement: "visible",
        plainTempAtomicReplacement: "visible",
        nestedDeletion: "inactive",
        untouchedSibling: "searchable",
        unrelatedStatusMs: Number(responsiveMs.toFixed(2)),
        manualUpdate: false,
      })
    );
  } finally {
    if (child?.exitCode === null) child.kill("SIGTERM");
    if (child) {
      await Promise.race([child.exited, Bun.sleep(5_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await safeRm(root);
  }
}

await main();
