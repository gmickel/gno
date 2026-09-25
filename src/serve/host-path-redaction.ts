/**
 * REST boundary for host paths: a caller the request-locality rule judges
 * remote never receives an `absPath` field from any `/api/*` JSON response,
 * nor the host `path` fields of the status, collection, connector, and
 * document-mutation routes (plus `configPath`/`dbPath` on status and the
 * `file://` `uri` of a document save). Same-host callers (the loopback Web
 * UI) keep them for Reveal, "Open original", and the Collections page.
 * Routes that stream original source bytes are exempt: their body is the
 * owner's file, not an API envelope.
 */

import {
  HOST_PATH_FIELDS,
  OWNER_CONFIG_PATH_FIELDS,
  withoutFields,
} from "../core/host-paths";
import {
  isLocalClientRequest,
  type RequestPeerServer,
} from "./request-locality";

const SOURCE_BYTE_ROUTES = new Set(["/api/doc-asset"]);
const OWNER_CONFIG_FIELDS: ReadonlySet<string> = new Set([
  ...HOST_PATH_FIELDS,
  ...OWNER_CONFIG_PATH_FIELDS,
]);
/** Document mutations answer with the file's host `path`. */
const DOC_PATH_FIELDS: ReadonlySet<string> = new Set([
  ...HOST_PATH_FIELDS,
  "path",
]);
/** A document save also names the file by a `file://` `uri`. */
const DOC_SAVE_FIELDS: ReadonlySet<string> = new Set([
  ...DOC_PATH_FIELDS,
  "uri",
]);
const ROUTE_FIELDS = new Map<string, ReadonlySet<string>>([
  ["/api/status", OWNER_CONFIG_FIELDS],
  ["/api/collections", OWNER_CONFIG_FIELDS],
  ["/api/collections/:name", OWNER_CONFIG_FIELDS],
  ["/api/connectors", OWNER_CONFIG_FIELDS],
  ["/api/connectors/install", OWNER_CONFIG_FIELDS],
  ["/api/docs", DOC_PATH_FIELDS],
  ["/api/docs/:id", DOC_SAVE_FIELDS],
  ["/api/docs/:id/rename", DOC_PATH_FIELDS],
  ["/api/docs/:id/move", DOC_PATH_FIELDS],
  ["/api/docs/:id/duplicate", DOC_PATH_FIELDS],
  ["/api/docs/:id/trash", DOC_PATH_FIELDS],
  ["/api/docs/:id/editable-copy", DOC_PATH_FIELDS],
  ["/api/folders", DOC_PATH_FIELDS],
]);

type RouteHandler = (
  req: Request,
  server: RequestPeerServer
) => Response | Promise<Response>;

/** The JSON response with every key in `fields` removed. */
export async function redactResponseHostPaths(
  response: Response,
  fields: ReadonlySet<string>
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json") || response.body === null) {
    return response;
  }
  const text = await response.text();
  const body = [...fields].some((field) => text.includes(`"${field}"`))
    ? JSON.stringify(withoutFields(JSON.parse(text) as unknown, fields))
    : text;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const redacting =
  (handler: RouteHandler, fields: ReadonlySet<string>): RouteHandler =>
  async (req, server) => {
    const response = await handler(req, server);
    return isLocalClientRequest(req, server)
      ? response
      : redactResponseHostPaths(response, fields);
  };

const isMethodTable = (route: unknown): route is Record<string, unknown> =>
  route !== null &&
  typeof route === "object" &&
  Object.getPrototypeOf(route) === Object.prototype;

/** Wrap every `/api/*` handler in the remote host-path redaction. */
export function withRemoteHostPathRedaction<T extends Record<string, unknown>>(
  routes: T
): T {
  const wrapped: Record<string, unknown> = { ...routes };
  for (const [path, route] of Object.entries(routes)) {
    if (!path.startsWith("/api/") || SOURCE_BYTE_ROUTES.has(path)) continue;
    const fields = ROUTE_FIELDS.get(path) ?? HOST_PATH_FIELDS;
    if (typeof route === "function") {
      wrapped[path] = redacting(route as RouteHandler, fields);
    } else if (isMethodTable(route)) {
      wrapped[path] = Object.fromEntries(
        Object.entries(route).map(([method, handler]) => [
          method,
          typeof handler === "function"
            ? redacting(handler as RouteHandler, fields)
            : handler,
        ])
      );
    }
  }
  return wrapped as T;
}
