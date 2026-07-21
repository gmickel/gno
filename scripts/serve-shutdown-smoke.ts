import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveConfigToPath } from "../src/config/saver";

const CRASH_PATTERN = /Bun has crashed|panic|segmentation fault|SIGSEGV/i;

interface SmokeOptions {
  bunPath: string;
  environment: "development" | "production";
  signal: "SIGINT" | "SIGTERM";
}

function parseOptions(args: string[]): SmokeOptions {
  let bunPath = process.execPath;
  let environment: SmokeOptions["environment"] = "production";
  let signal: SmokeOptions["signal"] = "SIGINT";

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--bun") {
      bunPath = args[index + 1] ?? bunPath;
      index += 1;
    } else if (value === "--development") {
      environment = "development";
    } else if (value === "--signal") {
      const next = args[index + 1];
      if (next !== "SIGINT" && next !== "SIGTERM") {
        throw new Error("--signal must be SIGINT or SIGTERM");
      }
      signal = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  return { bunPath, environment, signal };
}

async function waitForHealthy(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      await response.body?.cancel();
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
  const options = parseOptions(Bun.argv.slice(2));
  // node:fs/promises for temporary directory lifecycle; Bun has no equivalent.
  const root = await mkdtemp(join(tmpdir(), "gno-serve-shutdown-"));
  const configDir = join(root, "config");
  const collectionDir = join(root, "collection");
  const configPath = join(configDir, "config.yml");
  const dataDir = join(root, "data");
  const cacheDir = join(root, "cache");
  const port = 44_000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;

  await mkdir(collectionDir, { recursive: true });
  await Bun.write(join(collectionDir, "note.md"), "# Shutdown smoke\n");
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
  if (!saved.ok) {
    throw new Error(saved.error.message);
  }

  const child = Bun.spawn(
    [
      options.bunPath,
      "src/index.ts",
      "--config",
      configPath,
      "--index",
      "shutdown-smoke",
      "serve",
      "--port",
      String(port),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: options.environment,
        GNO_CONFIG_DIR: configDir,
        GNO_DATA_DIR: dataDir,
        GNO_CACHE_DIR: cacheDir,
        GNO_OFFLINE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();

  try {
    await waitForHealthy(baseUrl);
    const page = await fetch(baseUrl);
    await page.text();
    const collections = await fetch(`${baseUrl}/collections`);
    await collections.text();
    child.kill(options.signal);

    const timeout = Promise.withResolvers<never>();
    const timeoutId = setTimeout(() => {
      child.kill("SIGKILL");
      timeout.reject(new Error("Server did not exit within 10 seconds"));
    }, 10_000);
    const exitCode = await Promise.race([
      child.exited,
      timeout.promise,
    ]).finally(() => clearTimeout(timeoutId));
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;
    const output = `${stdout}\n${stderr}`;

    const bootstrapRacedShutdown = stderr.includes("Interrupted");
    if (
      exitCode !== 0 ||
      CRASH_PATTERN.test(output) ||
      bootstrapRacedShutdown
    ) {
      throw new Error(
        `Shutdown failed (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );
    }

    console.log(
      `Serve shutdown passed: ${options.bunPath} ${options.environment} ${options.signal}`
    );
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { force: true, recursive: true });
  }
}

await main();
