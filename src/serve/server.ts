/**
 * Bun.serve() web server for GNO web UI.
 * Opens DB once at startup, closes on shutdown.
 *
 * @module src/serve/server
 */

import { dirname, join, normalize, sep } from 'node:path'; // No Bun equivalent for path utils
import { getIndexDbPath } from '../app/constants';
import { getConfigPaths, isInitialized, loadConfig } from '../config';
import { SqliteAdapter } from '../store/sqlite/adapter';
import { routeApi } from './routes/api';

// Resolve public directory relative to this file
const PUBLIC_DIR = join(dirname(import.meta.path), 'public');

/**
 * Safely resolve a public file path, preventing directory traversal.
 * Returns null if path escapes PUBLIC_DIR.
 */
function resolvePublicPath(
  publicDir: string,
  urlPathname: string
): string | null {
  // Default to index.html for root
  let rel = urlPathname === '/' ? 'index.html' : urlPathname;

  // Make relative (strip leading slashes - critical for security)
  rel = rel.replace(/^\/+/, '');

  // Normalize and block traversal attempts
  const normalized = normalize(rel);
  if (normalized.startsWith(`..${sep}`) || normalized === '..') return null;

  // Join and enforce containment within publicDir
  const abs = join(publicDir, normalized);
  const prefix = publicDir.endsWith(sep) ? publicDir : publicDir + sep;
  if (!abs.startsWith(prefix) && abs !== publicDir) return null;

  return abs;
}

export interface ServeOptions {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Config path override */
  configPath?: string;
}

export interface ServeResult {
  success: boolean;
  error?: string;
}

/**
 * Build frontend bundle (app.tsx -> app.js).
 * Runs at server start to ensure TSX is transpiled for browsers.
 */
async function buildFrontend(): Promise<{ success: boolean; error?: string }> {
  const entrypoint = join(PUBLIC_DIR, 'app.tsx');
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: PUBLIC_DIR,
    target: 'browser',
    minify: process.env.NODE_ENV === 'production',
  });

  if (!result.success) {
    const errors = result.logs
      .filter((l) => l.level === 'error')
      .map((l) => l.message)
      .join('; ');
    return { success: false, error: `Frontend build failed: ${errors}` };
  }

  return { success: true };
}

/**
 * Start the web server.
 * Opens DB once, closes on SIGINT/SIGTERM.
 */
export async function startServer(
  options: ServeOptions = {}
): Promise<ServeResult> {
  const port = options.port ?? 3000;

  // Build frontend before starting server
  const buildResult = await buildFrontend();
  if (!buildResult.success) {
    return { success: false, error: buildResult.error };
  }

  // Check initialization
  const initialized = await isInitialized(options.configPath);
  if (!initialized) {
    return { success: false, error: 'GNO not initialized. Run: gno init' };
  }

  // Load config
  const configResult = await loadConfig(options.configPath);
  if (!configResult.ok) {
    return { success: false, error: configResult.error.message };
  }
  const config = configResult.value;

  // Open database once for server lifetime
  const store = new SqliteAdapter();
  const dbPath = getIndexDbPath();
  // Use actual config path (from options or default) for consistency
  const paths = getConfigPaths();
  const actualConfigPath = options.configPath ?? paths.configFile;
  store.setConfigPath(actualConfigPath);

  const openResult = await store.open(dbPath, config.ftsTokenizer);
  if (!openResult.ok) {
    return { success: false, error: openResult.error.message };
  }

  // Graceful shutdown handler
  const shutdown = async () => {
    console.log('\nShutting down...');
    await store.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Security headers for all responses
  const SECURITY_HEADERS = {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1', // Loopback only - no LAN exposure
    async fetch(req) {
      const url = new URL(req.url);

      // Validate Host header for DNS rebinding protection
      const host = req.headers.get('host');
      if (
        host &&
        !host.startsWith('127.0.0.1:') &&
        !host.startsWith('localhost:')
      ) {
        return new Response('Forbidden', {
          status: 403,
          headers: SECURITY_HEADERS,
        });
      }

      // API routes
      const apiResponse = await routeApi(store, req, url);
      if (apiResponse) {
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
          apiResponse.headers.set(k, v);
        }
        return apiResponse;
      }

      // Determine target path for static files
      let targetPath = url.pathname;

      // SPA routing: serve index.html for non-file routes
      if (!(targetPath.includes('.') || targetPath.startsWith('/api/'))) {
        targetPath = '/index.html';
      }

      // Safe path resolution - prevents directory traversal
      const absPath = resolvePublicPath(PUBLIC_DIR, targetPath);
      if (!absPath) {
        return new Response('Forbidden', {
          status: 403,
          headers: SECURITY_HEADERS,
        });
      }

      const file = Bun.file(absPath);
      if (await file.exists()) {
        return new Response(file, { headers: SECURITY_HEADERS });
      }

      // 404 for unknown routes
      return new Response('Not Found', {
        status: 404,
        headers: SECURITY_HEADERS,
      });
    },
  });

  console.log(`GNO server running at http://localhost:${server.port}`);
  console.log('Press Ctrl+C to stop');

  // Block forever - server runs until SIGINT/SIGTERM
  await new Promise(() => {});

  return { success: true };
}
