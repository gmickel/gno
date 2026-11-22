import type { HTMLBundle, Server } from "bun";

// node:fs/promises — no Bun equivalent for unlink of private sockets.
import { unlink } from "node:fs/promises";
// node:os — no Bun equivalent for the platform temporary directory.
import { tmpdir } from "node:os";
// node:path — no Bun path utils.
import { join } from "node:path";

import {
  getProductionSpaAssets,
  type ProductionSpaAssets,
} from "./spa-production";

type BunServer = Server<unknown>;

export type SpaBundleSource = {
  entryPath: string;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
};

const notFound = (): Response => new Response("Not Found", { status: 404 });

const isEnoent = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );

/**
 * Host Bun's headerless HTML / asset surface outside the public listener.
 *
 * Unix hosts use a private Unix-domain socket, so the raw bundle and generated
 * assets have no TCP origin at all. Windows falls back to an ephemeral
 * loopback listener plus an unguessable entry path. The public server proxies
 * the bytes and applies its normal security envelope before browser delivery.
 *
 * Production (`isDev === false`) serves the split SPA snapshot embedded from
 * `assets/spa-production.json.gz`. Source and compiled executables share that
 * path so first listen does not wait on `Bun.build`. Compiled binaries also
 * cannot call `Bun.build` on `/$bunfs` (ENOENT on the virtual root).
 * Development keeps the live HTMLBundle so HMR still works. Refresh the
 * snapshot with `bun scripts/build-spa-production.ts`.
 */
export async function createSpaBundleSource(
  bundle: HTMLBundle,
  isDev: boolean
): Promise<SpaBundleSource> {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const entryPath = `/__gno_spa_${nonce}`;

  if (isDev) {
    return hostPrivateSource({
      entryPath,
      isDev: true,
      nonce,
      routes: { [entryPath]: bundle },
    });
  }

  return createSplitProductionSource(entryPath);
}

async function createSplitProductionSource(
  entryPath: string
): Promise<SpaBundleSource> {
  const assets = await getProductionSpaAssets();
  return createInProcessProductionSource(assets, entryPath);
}

/**
 * Serve pre-built in-memory production SPA assets directly in-process without
 * spawning a second Bun.serve() or Unix-domain socket proxy hop.
 */
function createInProcessProductionSource(
  assets: ProductionSpaAssets,
  entryPath: string
): SpaBundleSource {
  const encoder = new TextEncoder();
  const htmlBytes = encoder.encode(assets.html);
  const htmlEtag = `W/"${Bun.hash(htmlBytes).toString(16)}"`;
  const encodedFiles = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; type: string }
  >();

  return {
    entryPath,
    close: async (): Promise<void> => {},
    fetch: async (request: Request): Promise<Response> => {
      const pathname = new URL(request.url).pathname;
      const isHead = request.method === "HEAD";
      if (pathname === entryPath) {
        return new Response(isHead ? null : htmlBytes, {
          headers: {
            "Content-Type": "text/html;charset=utf-8",
            "Content-Length": String(htmlBytes.byteLength),
            ETag: htmlEtag,
          },
        });
      }
      const file = assets.files[pathname];
      if (!file) {
        return notFound();
      }
      let cached = encodedFiles.get(pathname);
      if (!cached) {
        const raw = encoder.encode(file.text);
        // Copy into a guaranteed ArrayBuffer-backed view for BodyInit.
        const bytes = new Uint8Array(raw.byteLength);
        bytes.set(raw);
        cached = { bytes, type: file.type };
        encodedFiles.set(pathname, cached);
      }
      return new Response(isHead ? null : cached.bytes, {
        headers: {
          "Content-Type": cached.type,
          "Content-Length": String(cached.bytes.byteLength),
        },
      });
    },
  };
}

async function hostPrivateSource(options: {
  entryPath: string;
  fetchAsset?: (pathname: string) => Response;
  isDev: boolean;
  nonce: string;
  routes?: Record<string, HTMLBundle>;
}): Promise<SpaBundleSource> {
  let server: BunServer;
  let fetchPrivate: (request: Request) => Promise<Response>;
  let socketPath: string | null = null;
  const fallback = {
    fetch: (request: Request): Response => {
      if (!options.fetchAsset) {
        return notFound();
      }
      return options.fetchAsset(new URL(request.url).pathname);
    },
  };

  if (process.platform === "win32") {
    server = Bun.serve({
      development: options.isDev,
      hostname: "127.0.0.1",
      port: 0,
      routes: options.routes,
      ...fallback,
    });
    const origin = `http://127.0.0.1:${server.port}`;
    fetchPrivate = async (request): Promise<Response> => {
      const url = new URL(request.url);
      return fetch(`${origin}${url.pathname}${url.search}`, {
        method: request.method,
      });
    };
  } else {
    socketPath = join(tmpdir(), `gno-spa-${options.nonce.slice(0, 20)}.sock`);
    server = Bun.serve({
      development: options.isDev,
      routes: options.routes,
      unix: socketPath,
      ...fallback,
    });
    fetchPrivate = async (request): Promise<Response> => {
      const url = new URL(request.url);
      return fetch(`http://localhost${url.pathname}${url.search}`, {
        method: request.method,
        unix: socketPath ?? undefined,
      });
    };
  }

  let closed = false;
  return {
    close: async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await server.stop(true);
      if (socketPath) {
        try {
          await unlink(socketPath);
        } catch (error) {
          if (!isEnoent(error)) {
            throw error;
          }
        }
      }
    },
    entryPath: options.entryPath,
    fetch: fetchPrivate,
  };
}
