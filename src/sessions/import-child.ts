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
 * Executed directly, this module is the child entry: it reads one request
 * from stdin and writes one JSON result line to stdout. The request carries
 * the caller's loaded config, so the child imports with exactly the config
 * the server holds.
 *
 * @module src/sessions/import-child
 */

import type { Config } from "../config/types";
import type { SessionImportReceipt } from "./types";

import { initStore } from "../cli/commands/shared";
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
  const opened = await initStore({
    configPath: request.configPath,
    indexName: request.indexName,
    allowEmptyCollections: true,
  });
  if (!opened.ok) throw new Error(opened.error);
  try {
    return await new SessionsService({
      config: request.config,
      configPath: request.configPath,
      indexName: request.indexName,
      store: opened.store,
    }).import(input, { allowPaths: false });
  } finally {
    await opened.store.close();
  }
}

/**
 * Import a registered source without blocking the caller's event loop.
 * Throws a `SessionsError` for typed failures and a plain `Error` otherwise.
 */
export async function importInChildProcess(
  request: ImportChildRequest
): Promise<SessionImportReceipt> {
  // A compiled single-file executable cannot run an external TS entry.
  if (import.meta.dir.includes("$bunfs")) return importInThisProcess(request);
  const child = Bun.spawn({
    cmd: [process.execPath, import.meta.path],
    env: process.env,
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

async function main(): Promise<void> {
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

if (import.meta.main) await main();
