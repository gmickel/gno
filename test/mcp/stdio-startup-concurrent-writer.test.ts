/**
 * fn-204 R2: a stdio `gno mcp` started while another process is writing the
 * index answers `initialize`. Startup config sync used to fail with
 * "database is locked" when the other writer committed during it.
 */

import { afterEach, expect, test } from "bun:test";
// node:fs/promises — mkdir/mkdtemp are directory-structure ops
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os — tmpdir has no Bun equivalent
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join, resolve } from "node:path";

import { safeRm } from "../helpers/cleanup";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await safeRm(root);
});

async function isolatedIndex(): Promise<{
  env: Record<string, string>;
  dbPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "gno-fn204-mcp-"));
  roots.push(root);
  const notes = join(root, "notes");
  await mkdir(notes, { recursive: true });
  for (let i = 0; i < 5; i += 1) {
    await Bun.write(
      join(notes, `n${i}.md`),
      `# Note ${i}\n\nalpha beta ${i}\n`
    );
  }
  await mkdir(join(root, "config"), { recursive: true });
  await Bun.write(
    join(root, "config", "index.yml"),
    JSON.stringify({
      version: "1.0",
      ftsTokenizer: "porter",
      busyTimeoutMs: 15_000,
      collections: [
        {
          name: "notes",
          path: notes,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
      contexts: [],
      contentTypes: [],
    })
  );
  const env = {
    ...(process.env as Record<string, string>),
    GNO_CONFIG_DIR: join(root, "config"),
    GNO_DATA_DIR: join(root, "data"),
    GNO_CACHE_DIR: join(root, "cache"),
    GNO_OFFLINE: "1",
  };
  const update = Bun.spawnSync({
    cmd: [process.execPath, "src/index.ts", "update"],
    cwd: REPO_ROOT,
    env,
  });
  expect(update.exitCode).toBe(0);
  return { env, dbPath: join(root, "data", "index-default.sqlite") };
}

test("gno mcp answers initialize while another process commits a write during its startup", async () => {
  const { env, dbPath } = await isolatedIndex();
  // Hold the write lock across gno mcp's startup and commit in the middle of it.
  const writer = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `import { Database } from "bun:sqlite";
       const db = new Database(${JSON.stringify(dbPath)});
       db.exec("BEGIN IMMEDIATE");
       db.run("INSERT INTO schema_meta (key, value) VALUES ('fn-204-mcp-probe', '1') ON CONFLICT(key) DO UPDATE SET value = value || '1'");
       console.log("LOCKED");
       await Bun.sleep(1500);
       db.exec("COMMIT");`,
    ],
    stdout: "pipe",
    stderr: "inherit",
  });
  const locked = await writer.stdout.getReader().read();
  expect(new TextDecoder().decode(locked.value)).toContain("LOCKED");

  const mcp = Bun.spawn({
    cmd: [process.execPath, "src/index.ts", "mcp"],
    cwd: REPO_ROOT,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    mcp.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fn-204", version: "1" },
        },
      })}\n`
    );
    void mcp.stdin.flush();
    const reader = mcp.stdout.getReader();
    const first = await Promise.race([
      reader
        .read()
        .then((chunk) =>
          chunk.done ? null : new TextDecoder().decode(chunk.value)
        ),
      mcp.exited.then(() => null),
      Bun.sleep(25_000).then(() => null),
    ]);
    const stderr = first === null ? await new Response(mcp.stderr).text() : "";
    expect(
      first === null
        ? `no initialize response; stderr: ${stderr.trim()}`
        : "answered"
    ).toBe("answered");
    const response = JSON.parse((first as string).split("\n")[0] as string) as {
      result?: { protocolVersion?: string };
    };
    expect(response.result?.protocolVersion).toBeTruthy();
  } finally {
    mcp.kill("SIGKILL");
    await mcp.exited;
    await writer.exited;
  }
}, 40_000);
