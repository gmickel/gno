/**
 * Run a registered-source import in a child process.
 *
 * Parsing, sanitizing and above all the index sync of thousands of archive
 * records are CPU-bound and synchronous (each archive file syncs in one
 * SQLite transaction), so a long-lived server that imported in-process would
 * stop answering every request until the import finished. `gno serve` runs
 * the same `SessionsService.import` here instead, in a child with its own
 * store connection: the archive import lock, receipts and error codes are
 * unchanged.
 *
 * The child reads one request from stdin and writes one JSON result line to
 * stdout. The request carries the caller's loaded config: the child opens
 * the index without syncing any config into it and imports with exactly the
 * config the server holds. From source the child runs this module; a
 * compiled executable re-runs itself with `IMPORT_CHILD_ENV` set, which the
 * CLI entry routes here before any command runs.
 *
 * @module src/sessions/import-child
 */

import type { Config } from "../config/types";
import type { SessionImportReceipt } from "./types";

import { getIndexDbPath } from "../app/constants";
import { SqliteAdapter } from "../store/sqlite/adapter";
import { assertSessionBinding } from "./binding";
import { IMPORT_CHILD_ENV } from "./import-child-env";
import { SessionsService } from "./service";
import { type SessionsErrorCode, SessionsError } from "./types";

export interface ImportChildRequest {
  config: Config;
  configPath: string;
  indexName: string;
  sourceId: string;
  dryRun: boolean;
  limit?: number;
}

type ImportChildResult =
  | { ok: true; receipt: SessionImportReceipt }
  | { ok: false; code: SessionsErrorCode | null; message: string };

async function importInThisProcess(
  request: ImportChildRequest
): Promise<SessionImportReceipt> {
  const input = {
    sourceId: request.sourceId,
    dryRun: request.dryRun,
    limit: request.limit,
  };
  if (request.dryRun) {
    return new SessionsService({
      config: request.config,
      configPath: request.configPath,
      indexName: request.indexName,
    }).import(input, { allowPaths: false });
  }
  const dbPath = getIndexDbPath(request.indexName);
  await assertSessionBinding({
    config: request.config,
    configPath: request.configPath,
    indexName: request.indexName,
    dbPath,
  });
  // The server already projected this config into the index; the child only
  // opens it (no collection/context sync).
  const store = new SqliteAdapter();
  store.setConfigPath(request.configPath);
  const opened = await store.open(
    dbPath,
    request.config.ftsTokenizer,
    request.config.busyTimeoutMs
  );
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    return await new SessionsService({
      config: request.config,
      configPath: request.configPath,
      indexName: request.indexName,
      store,
    }).import(input, { allowPaths: false });
  } finally {
    await store.close();
  }
}

/**
 * Import a registered source without blocking the caller's event loop.
 * Throws a `SessionsError` for typed failures and a plain `Error` otherwise.
 */
export async function importInChildProcess(
  request: ImportChildRequest
): Promise<SessionImportReceipt> {
  // A compiled executable cannot run an external TS entry: it re-runs itself.
  const compiled = import.meta.dir.includes("$bunfs");
  const child = Bun.spawn({
    cmd: compiled ? [process.execPath] : [process.execPath, import.meta.path],
    env: compiled ? { ...process.env, [IMPORT_CHILD_ENV]: "1" } : process.env,
    stdin: new Blob([JSON.stringify(request)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let result: ImportChildResult | null = null;
  try {
    result = JSON.parse(line) as ImportChildResult;
  } catch {
    result = null;
  }
  if (!result) {
    throw new Error(
      `session import child exited ${exitCode}: ${stderr.trim().slice(-2000)}`
    );
  }
  if (result.ok) return result.receipt;
  if (result.code) throw new SessionsError(result.code, result.message);
  throw new Error(result.message);
}

/** Child entry: one request on stdin, one JSON result line on stdout. */
export async function runImportChild(): Promise<void> {
  // Nothing this child starts may re-enter child mode.
  delete process.env[IMPORT_CHILD_ENV];
  let result: ImportChildResult;
  try {
    const request = JSON.parse(
      await new Response(Bun.stdin.stream()).text()
    ) as ImportChildRequest;
    result = { ok: true, receipt: await importInThisProcess(request) };
  } catch (error) {
    result =
      error instanceof SessionsError
        ? { ok: false, code: error.code, message: error.message }
        : {
            ok: false,
            code: null,
            message: error instanceof Error ? error.message : String(error),
          };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) await runImportChild();
