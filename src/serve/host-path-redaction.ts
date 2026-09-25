/**
 * REST boundary for host paths: a caller the request-locality rule judges
 * remote never receives an `absPath` field from any `/api/*` JSON response.
 * Same-host callers (the loopback Web UI) keep them for Reveal and
 * "Open original".
 */

import { withoutHostPaths } from "../core/host-paths";
import {
  isLocalClientRequest,
  type RequestPeerServer,
} from "./request-locality";

const HOST_PATH_KEY = '"absPath"';

type RouteHandler = (
  req: Request,
  server: RequestPeerServer
) => Response | Promise<Response>;

/** The JSON response with every `absPath` field removed. */
export async function redactResponseHostPaths(
  response: Response
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json") || response.body === null) {
    return response;
  }
  const text = await response.text();
  const body = text.includes(HOST_PATH_KEY)
    ? JSON.stringify(withoutHostPaths(JSON.parse(text) as unknown))
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
  (handler: RouteHandler): RouteHandler =>
  async (req, server) => {
    const response = await handler(req, server);
    return isLocalClientRequest(req, server)
      ? response
      : redactResponseHostPaths(response);
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
    if (!path.startsWith("/api/")) continue;
    if (typeof route === "function") {
      wrapped[path] = redacting(route as RouteHandler);
    } else if (isMethodTable(route)) {
      wrapped[path] = Object.fromEntries(
        Object.entries(route).map(([method, handler]) => [
          method,
          typeof handler === "function"
            ? redacting(handler as RouteHandler)
            : handler,
        ])
      );
    }
  }
  return wrapped as T;
}
