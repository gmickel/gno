import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

import { saveConfigToPath } from "../src/config/saver";
import { startBackgroundRuntime } from "../src/serve/background-runtime";

async function waitForHealthy(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server still starting.
    }
    await Bun.sleep(100);
  }

  throw new Error(`Timed out waiting for ${baseUrl}`);
}

async function main(): Promise<void> {
  // node:fs/promises for mkdtemp/mkdir/rm only; Bun lacks temp-dir helpers.
  const root = await mkdtemp(join(tmpdir(), "gno-web-ui-smoke-"));
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  const cacheDir = join(root, "cache");
  const collectionDir = join(root, "collection");
  const configPath = join(configDir, "index.yml");
  const indexName = "web-ui-smoke";
  const port = 43000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;

  await mkdir(collectionDir, { recursive: true });
  await Bun.write(
    join(collectionDir, "smoke-note.md"),
    "# Smoke Test Note\n\nThis note powers the browser smoke test.\n\nsmoke-search-needle\n"
  );
  await mkdir(join(collectionDir, "projects"), { recursive: true });
  await Bun.write(
    join(collectionDir, "projects", "roadmap.md"),
    "# Roadmap\n\nBrowse tree smoke folder.\n"
  );

  const originalEnv = {
    GNO_CONFIG_DIR: process.env.GNO_CONFIG_DIR,
    GNO_DATA_DIR: process.env.GNO_DATA_DIR,
    GNO_CACHE_DIR: process.env.GNO_CACHE_DIR,
    GNO_OFFLINE: process.env.GNO_OFFLINE,
  };

  process.env.GNO_CONFIG_DIR = configDir;
  process.env.GNO_DATA_DIR = dataDir;
  process.env.GNO_CACHE_DIR = cacheDir;
  process.env.GNO_OFFLINE = "1";

  try {
    const saveResult = await saveConfigToPath(
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

    if (!saveResult.ok) {
      throw new Error(saveResult.error.message);
    }

    const seedRuntime = await startBackgroundRuntime({
      configPath,
      index: indexName,
      offline: true,
    });
    if (!seedRuntime.success) {
      throw new Error(seedRuntime.error);
    }

    try {
      await seedRuntime.runtime.syncAll({ triggerEmbed: false });
    } finally {
      await seedRuntime.runtime.dispose();
    }

    const server = Bun.spawn(
      [
        "bun",
        "run",
        "src/index.ts",
        "--config",
        configPath,
        "--index",
        indexName,
        "serve",
        "--port",
        String(port),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "production",
          GNO_CONFIG_DIR: configDir,
          GNO_DATA_DIR: dataDir,
          GNO_CACHE_DIR: cacheDir,
          GNO_OFFLINE: "1",
        },
        stdout: "inherit",
        stderr: "inherit",
      }
    );

    const browser = await chromium.launch();

    try {
      await waitForHealthy(baseUrl);

      const page = await browser.newPage();
      await page.goto(`${baseUrl}/browse?collection=notes`, {
        waitUntil: "networkidle",
      });
      await page.getByRole("tree", { name: "Browse tree" }).waitFor();
      await page.getByRole("button", { name: "Expand notes" }).click();
      await page.getByRole("treeitem", { name: /projects/i }).click();
      await page.waitForURL(/\/browse\?collection=notes&path=projects/);
      await page
        .locator("table")
        .getByText("Roadmap", { exact: true })
        .waitFor();

      await page.goto(`${baseUrl}/search`, { waitUntil: "networkidle" });
      await page.getByRole("textbox").fill("smoke-search-needle");
      await page
        .locator("main form")
        .getByRole("button", { name: "Search" })
        .click();
      await page.getByRole("heading", { name: "Smoke Test Note" }).waitFor();
      await page.getByRole("heading", { name: "Smoke Test Note" }).click();
      await page.waitForURL(/\/doc\?/);
      await page
        .getByText("This note powers the browser smoke test.")
        .first()
        .waitFor();
      console.log("Web UI smoke passed");
    } finally {
      await browser.close();
      server.kill();
      await server.exited;
    }
  } finally {
    process.env.GNO_CONFIG_DIR = originalEnv.GNO_CONFIG_DIR;
    process.env.GNO_DATA_DIR = originalEnv.GNO_DATA_DIR;
    process.env.GNO_CACHE_DIR = originalEnv.GNO_CACHE_DIR;
    process.env.GNO_OFFLINE = originalEnv.GNO_OFFLINE;
    await rm(root, { force: true, recursive: true });
  }
}

await main();
