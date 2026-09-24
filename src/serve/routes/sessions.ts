/**
 * REST adapters for the session archive: status, manual import of
 * registered sources, and owner-only discovery/registration/init.
 *
 * Thin adapters over the transport-neutral sessions service. The instance is
 * archive-bound iff its loaded config carries a `sessions` block; there is no
 * cross-index routing. Remote callers may read status and import a registered
 * source by ID; they never name host paths and never learn host directories.
 * Discovery, source registration/removal and archive init are same-host only.
 *
 * @module src/serve/routes/sessions
 */

import type { Config } from "../../config/types";
import type { SqliteAdapter } from "../../store/sqlite/adapter";
import type { RequestPeerServer } from "../request-locality";
import type { ContextHolder } from "./api";

import { getIndexDbPath } from "../../app/constants";
import { getConfigPaths } from "../../config";
import { withContentTypeRules } from "../../ingestion";
import { assertSessionBinding } from "../../sessions/binding";
import { SessionSourceSchema, watchedCollections } from "../../sessions/config";
import { importInChildProcess } from "../../sessions/import-child";
import { SessionsService } from "../../sessions/service";
import {
  addSessionSource,
  initSessionArchive,
  removeSessionSource,
} from "../../sessions/setup";
import {
  SESSION_HARNESSES,
  type SessionHarness,
  type SessionImportReceipt,
  remoteSafeSessionsError,
  type SessionsErrorCode,
  SESSIONS_VALIDATION_CODES,
} from "../../sessions/types";
import { isLocalClientRequest } from "../request-locality";

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL = 500;

/** Generic REST error code per status; `details.sessionsCode` is specific. */
const WIRE_CODES: Readonly<Record<number, string>> = {
  [HTTP_BAD_REQUEST]: "VALIDATION",
  [HTTP_FORBIDDEN]: "FORBIDDEN",
  [HTTP_CONFLICT]: "BUSY",
  [HTTP_INTERNAL]: "RUNTIME",
};

/** Keys accepted by POST /api/sessions/import. */
const IMPORT_KEYS = new Set(["sourceId", "dryRun", "limit"]);
/** Path-import keys that only local CLI/SDK callers may use. */
const IMPORT_PATH_KEYS = ["collection", "format"] as const;
const SOURCE_KEYS = new Set([
  "id",
  "harness",
  "path",
  "collection",
  "projects",
]);
const INIT_KEYS = new Set(["archive", "collection"]);

export interface SessionsRouteDeps {
  /** Peer lookup for same-host checks; absent means remote (fail closed). */
  server?: RequestPeerServer;
  /** Discovery environment override (tests use a synthetic home). */
  env?: NodeJS.ProcessEnv;
}

export interface SessionsInitResponse {
  schemaVersion: "1";
  index: string;
  collection: string;
  archiveRoot: string;
  created: boolean;
}

export interface SessionsSourceAddResponse {
  id: string;
  registered: true;
}

export interface SessionsSourceRemoveResponse {
  id: string;
  removed: true;
  archiveRetained: true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sessionsError(
  code: SessionsErrorCode,
  message: string,
  status: number
): Response {
  return Response.json(
    {
      error: {
        code: WIRE_CODES[status] ?? "RUNTIME",
        message,
        details: { sessionsCode: code },
      },
    },
    { status }
  );
}

/**
 * Map a thrown error onto the REST envelope; `details.sessionsCode` is
 * stable and messages never carry host paths.
 */
export function sessionsErrorResponse(error: unknown): Response {
  const typed = remoteSafeSessionsError(error);
  if (typed.code === "SESSIONS_BUSY") {
    return sessionsError(typed.code, typed.message, HTTP_CONFLICT);
  }
  return sessionsError(
    typed.code,
    typed.message,
    SESSIONS_VALIDATION_CODES.has(typed.code) ? HTTP_BAD_REQUEST : HTTP_INTERNAL
  );
}

const invalid = (message: string): Response =>
  sessionsError("SESSIONS_INVALID_INPUT", message, HTTP_BAD_REQUEST);

function localOnly(
  req: Request,
  deps: SessionsRouteDeps,
  action: string
): Response | null {
  if (isLocalClientRequest(req, deps.server)) return null;
  return Response.json(
    {
      error: {
        code: "FORBIDDEN",
        message: `${action} is only available to a same-host browser`,
      },
    },
    { status: HTTP_FORBIDDEN }
  );
}

async function readObjectBody(
  req: Request
): Promise<
  { ok: true; body: Record<string, unknown> } | { ok: false; res: Response }
> {
  let body: unknown;
  try {
    const text = await req.text();
    body = text.trim() ? JSON.parse(text) : {};
  } catch {
    return { ok: false, res: invalid("Invalid JSON body") };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, res: invalid("Request body must be a JSON object") };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

function instanceIdentity(ctxHolder: ContextHolder): {
  configPath: string;
  indexName: string;
} {
  return {
    configPath: ctxHolder.actualConfigPath ?? "",
    indexName: ctxHolder.current.indexName,
  };
}

/** Refuse an archive config opened against a different index (and vice versa). */
async function assertInstanceBinding(ctxHolder: ContextHolder): Promise<void> {
  const { configPath, indexName } = instanceIdentity(ctxHolder);
  if (!ctxHolder.config.sessions) return;
  await assertSessionBinding({
    config: ctxHolder.config,
    configPath,
    indexName,
    dbPath: getIndexDbPath(indexName),
  });
}

/** Service over the instance's own config/index pair, binding checked. */
async function archiveService(
  ctxHolder: ContextHolder,
  store?: SqliteAdapter
): Promise<SessionsService> {
  await assertInstanceBinding(ctxHolder);
  const { configPath, indexName } = instanceIdentity(ctxHolder);
  return new SessionsService({
    config: ctxHolder.config,
    configPath,
    indexName,
    store,
  });
}

/**
 * Adopt a config the sessions service already persisted: project collections
 * and contexts into the open store, swap the in-memory context, and refresh
 * the watcher, egress policy and mutation generations (same sequence as the
 * config-sync route helpers).
 */
async function adoptConfig(
  ctxHolder: ContextHolder,
  store: SqliteAdapter,
  config: Config
): Promise<void> {
  const collections = await store.syncCollections(config.collections);
  if (!collections.ok) {
    throw new Error(
      `Config saved but collection sync failed: ${collections.error.message}`
    );
  }
  const contexts = await store.syncContexts(config.contexts ?? []);
  if (!contexts.ok) {
    throw new Error(
      `Config saved but context sync failed: ${contexts.error.message}`
    );
  }
  ctxHolder.config = config;
  ctxHolder.current = { ...ctxHolder.current, config };
  ctxHolder.watchService?.updateCollections(
    watchedCollections(config),
    withContentTypeRules({}, config)
  );
  await ctxHolder.invalidateEgressPolicy?.();
  ctxHolder.markContentMutation?.();
  ctxHolder.markIndexMutation?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/sessions/status */
export async function handleSessionsStatus(
  ctxHolder: ContextHolder
): Promise<Response> {
  try {
    const service = await archiveService(ctxHolder);
    return Response.json(await service.status());
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}

/**
 * POST /api/sessions/import
 * Body: { sourceId, dryRun?, limit? }. Host paths are refused before any read.
 */
export async function handleSessionsImport(
  ctxHolder: ContextHolder,
  req: Request
): Promise<Response> {
  const parsed = await readObjectBody(req);
  if (!parsed.ok) return parsed.res;
  const { body } = parsed;
  if ("paths" in body) {
    return sessionsError(
      "SESSIONS_UNSAFE_PATH",
      "Host paths cannot be named over REST; import a registered source by its ID.",
      HTTP_BAD_REQUEST
    );
  }
  for (const key of IMPORT_PATH_KEYS) {
    if (key in body) {
      return invalid(
        `"${key}" applies to local path imports only; a registered source imports into its registered collections.`
      );
    }
  }
  const unknown = Object.keys(body).filter((key) => !IMPORT_KEYS.has(key));
  if (unknown.length > 0) {
    return invalid(`Unknown field(s): ${unknown.join(", ")}`);
  }
  if (body.sourceId === undefined) {
    return sessionsError(
      "SESSIONS_SELECTION_REQUIRED",
      "Select a registered source: { sourceId }.",
      HTTP_BAD_REQUEST
    );
  }
  if (typeof body.sourceId !== "string" || !body.sourceId.trim()) {
    return invalid("sourceId must be a non-empty string");
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    return invalid("dryRun must be a boolean");
  }
  if (
    body.limit !== undefined &&
    (typeof body.limit !== "number" || !Number.isSafeInteger(body.limit))
  ) {
    return invalid("limit must be an integer");
  }

  let receipt: SessionImportReceipt;
  try {
    await assertInstanceBinding(ctxHolder);
    const { configPath, indexName } = instanceIdentity(ctxHolder);
    // A child process keeps this server answering during a long import.
    receipt = await importInChildProcess({
      config: ctxHolder.config,
      configPath: configPath || getConfigPaths().configFile,
      indexName,
      sourceId: body.sourceId.trim(),
      dryRun: body.dryRun === true,
      limit: body.limit as number | undefined,
    });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
  if (!receipt.dryRun && receipt.lexical.collections.length > 0) {
    ctxHolder.markContentMutation?.();
    ctxHolder.markIndexMutation?.();
    // Debounced embedding pass over the newly synced archive records.
    ctxHolder.scheduler?.notifySyncComplete(receipt.lexical.collections);
  }
  return Response.json(receipt);
}

/** GET /api/sessions/discover (same-host only: returns host paths). */
export async function handleSessionsDiscover(
  ctxHolder: ContextHolder,
  req: Request,
  deps: SessionsRouteDeps = {}
): Promise<Response> {
  const refused = localOnly(req, deps, "Session discovery");
  if (refused) return refused;
  try {
    const { configPath, indexName } = instanceIdentity(ctxHolder);
    return Response.json(
      await new SessionsService({
        config: ctxHolder.config,
        configPath,
        indexName,
        env: deps.env,
      }).discover()
    );
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}

/** POST /api/sessions/sources (same-host only). */
export async function handleSessionsAddSource(
  ctxHolder: ContextHolder,
  store: SqliteAdapter,
  req: Request,
  deps: SessionsRouteDeps = {}
): Promise<Response> {
  const refused = localOnly(req, deps, "Registering a session source");
  if (refused) return refused;
  const parsed = await readObjectBody(req);
  if (!parsed.ok) return parsed.res;
  const { body } = parsed;
  const unknown = Object.keys(body).filter((key) => !SOURCE_KEYS.has(key));
  if (unknown.length > 0) {
    return invalid(`Unknown field(s): ${unknown.join(", ")}`);
  }
  if (
    typeof body.harness !== "string" ||
    !(SESSION_HARNESSES as readonly string[]).includes(body.harness)
  ) {
    return sessionsError(
      "SESSIONS_UNSUPPORTED_FORMAT",
      `harness must be one of: ${SESSION_HARNESSES.join(", ")}.`,
      HTTP_BAD_REQUEST
    );
  }
  const source = SessionSourceSchema.safeParse(body);
  if (!source.success) {
    const issue = source.error.issues[0];
    return invalid(
      `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid source"}`
    );
  }
  try {
    const { configPath } = instanceIdentity(ctxHolder);
    await assertInstanceBinding(ctxHolder);
    const config = await addSessionSource({
      configPath,
      id: source.data.id,
      harness: source.data.harness as SessionHarness,
      path: source.data.path,
      collection: source.data.collection,
      projects: source.data.projects,
    });
    await adoptConfig(ctxHolder, store, config);
  } catch (error) {
    return sessionsErrorResponse(error);
  }
  const response: SessionsSourceAddResponse = {
    id: source.data.id,
    registered: true,
  };
  return Response.json(response);
}

/** DELETE /api/sessions/sources/:id (same-host only; archive retained). */
export async function handleSessionsRemoveSource(
  ctxHolder: ContextHolder,
  store: SqliteAdapter,
  id: string,
  req: Request,
  deps: SessionsRouteDeps = {}
): Promise<Response> {
  const refused = localOnly(req, deps, "Removing a session source");
  if (refused) return refused;
  if (!id) return invalid("Source ID is required");
  try {
    const { configPath } = instanceIdentity(ctxHolder);
    await assertInstanceBinding(ctxHolder);
    const config = await removeSessionSource({ configPath, id });
    await adoptConfig(ctxHolder, store, config);
  } catch (error) {
    return sessionsErrorResponse(error);
  }
  const response: SessionsSourceRemoveResponse = {
    id,
    removed: true,
    archiveRetained: true,
  };
  return Response.json(response);
}

/**
 * POST /api/sessions/init (same-host only)
 * Body: { archive, collection }. Binds this instance's own config/index pair;
 * the service refuses the default config and the default index.
 */
export async function handleSessionsInit(
  ctxHolder: ContextHolder,
  store: SqliteAdapter,
  req: Request,
  deps: SessionsRouteDeps = {}
): Promise<Response> {
  const refused = localOnly(req, deps, "Creating a session archive");
  if (refused) return refused;
  const parsed = await readObjectBody(req);
  if (!parsed.ok) return parsed.res;
  const { body } = parsed;
  const unknown = Object.keys(body).filter((key) => !INIT_KEYS.has(key));
  if (unknown.length > 0) {
    return invalid(`Unknown field(s): ${unknown.join(", ")}`);
  }
  if (
    typeof body.archive !== "string" ||
    !body.archive.trim() ||
    typeof body.collection !== "string" ||
    !body.collection.trim()
  ) {
    return sessionsError(
      "SESSIONS_DESTINATION_REQUIRED",
      "Archive init needs { archive: <absolute dir>, collection: <name> }.",
      HTTP_BAD_REQUEST
    );
  }
  const { configPath, indexName } = instanceIdentity(ctxHolder);
  if (!configPath) {
    return invalid("This server has no resolved config path.");
  }
  try {
    const result = await initSessionArchive({
      configPath,
      indexName,
      archiveRoot: body.archive.trim(),
      collection: body.collection.trim(),
    });
    await adoptConfig(ctxHolder, store, result.config);
    const response: SessionsInitResponse = {
      schemaVersion: "1",
      index: indexName,
      collection: body.collection.trim(),
      archiveRoot: result.archiveRoot,
      created: result.created,
    };
    return Response.json(response);
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}
