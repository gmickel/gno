/**
 * Bun.serve() web server for GNO web UI.
 * Uses Bun's fullstack dev server with HTML imports.
 * Opens DB once at startup, closes on shutdown.
 *
 * @module src/serve/server
 */

import { getIndexDbPath } from '../app/constants';
import { getConfigPaths, isInitialized, loadConfig } from '../config';
import { SqliteAdapter } from '../store/sqlite/adapter';
// HTML import - Bun handles bundling TSX/CSS automatically
import homepage from './public/index.html';
import { routeApi } from './routes/api';

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
 * Start the web server.
 * Opens DB once, closes on SIGINT/SIGTERM.
 */
export async function startServer(
  options: ServeOptions = {}
): Promise<ServeResult> {
  const port = options.port ?? 3000;

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

    // HTML routes - Bun automatically bundles TSX/CSS
    routes: {
      '/': homepage,
      '/search': homepage, // SPA routes
      '/browse': homepage,
      '/doc': homepage,
    },

    // Enable development mode for HMR and console logging
    development: process.env.NODE_ENV !== 'production',

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

      // 404 for unknown routes (HTML routes handled by routes option)
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
