/**
 * REST boundary for host paths: a caller the request-locality rule judges
 * remote never receives an `absPath` field from any `/api/*` JSON response,
 * nor the owner configuration paths (`configPath`, `dbPath`, `path`) of the
 * status, collection, and connector routes. Same-host callers (the loopback
 * Web UI) keep them for Reveal, "Open original", and the Collections page.
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
const OWNER_CONFIG_ROUTES = new Set([
  "/api/status",
  "/api/collections",
  "/api/collections/:name",
  "/api/connectors",
  "/api/connectors/install",
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
    const fields = OWNER_CONFIG_ROUTES.has(path)
      ? OWNER_CONFIG_FIELDS
      : HOST_PATH_FIELDS;
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
