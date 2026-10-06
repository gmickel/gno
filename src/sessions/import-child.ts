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
 * The child reads one request line from stdin and writes one JSON result line
 * to stdout. The parent keeps stdin open for the child's lifetime: EOF means
 * the parent died, and the child exits instead of importing on as an orphan.
 * A resident kills its import children when it shuts down, and every import
 * has a timeout. The request carries the caller's loaded config: the child opens
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
import { isStandaloneExecutable } from "../serve/spa-production-build";
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

/** Longest a single import may run before its child is killed. */
export const SESSION_IMPORT_TIMEOUT_MS = 30 * 60_000;

/** Import children still running in this process. */
const liveChildren = new Set<Bun.Subprocess>();

/** Kill every running import child (resident shutdown). */
export function killImportChildren(): void {
  for (const child of liveChildren) child.kill("SIGKILL");
}

/**
 * Import a registered source without blocking the caller's event loop.
 * Throws a `SessionsError` for typed failures and a plain `Error` otherwise.
 */
export async function importInChildProcess(
  request: ImportChildRequest,
  options: { timeoutMs?: number } = {}
): Promise<SessionImportReceipt> {
  // A compiled executable cannot run an external TS entry: it re-runs itself.
  // Shared check: covers the POSIX `/$bunfs/` and Windows `B:/~BUN/` roots.
  const compiled = isStandaloneExecutable();
  const child = Bun.spawn({
    cmd: compiled ? [process.execPath] : [process.execPath, import.meta.path],
    env: compiled ? { ...process.env, [IMPORT_CHILD_ENV]: "1" } : process.env,
    // The request line, then held open as the child's lifeline.
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  liveChildren.add(child);
  const timeoutMs = options.timeoutMs ?? SESSION_IMPORT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  let output: [string, string, number];
  try {
    void child.stdin.write(`${JSON.stringify(request)}\n`);
    void child.stdin.flush();
    output = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
  } finally {
    clearTimeout(timer);
    liveChildren.delete(child);
    void Promise.resolve(child.stdin.end()).catch(() => undefined);
  }
  const [stdout, stderr, exitCode] = output;
  if (timedOut) {
    throw new Error(
      `session import timed out after ${Math.round(timeoutMs / 1000)} s`
    );
  }
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

/** Read the request line; afterwards stdin is only the lifeline. */
async function readRequestLine(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text.split("\n")[0] ?? "";
}

/** Child entry: one request line on stdin, one JSON result line on stdout. */
export async function runImportChild(): Promise<void> {
  // Nothing this child starts may re-enter child mode.
  delete process.env[IMPORT_CHILD_ENV];
  const reader = Bun.stdin.stream().getReader();
  let finished = false;
  let result: ImportChildResult;
  try {
    const request = JSON.parse(
      await readRequestLine(reader)
    ) as ImportChildRequest;
    // The parent holds stdin open until it has our result; EOF before that
    // means it died. Noticed between import steps.
    void (async () => {
      try {
        while (!(await reader.read()).done) {
          // nothing is written after the request
        }
      } catch {
        // a broken pipe is the same as EOF
      }
      if (!finished) process.exit(1);
    })();
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
  finished = true;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  void reader.cancel().catch(() => undefined);
}

if (import.meta.main) await runImportChild();
