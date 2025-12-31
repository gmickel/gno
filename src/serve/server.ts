/**
 * Bun.serve() web server for GNO web UI.
 * Opens DB once at startup, closes on shutdown.
 *
 * @module src/serve/server
 */

import { dirname, join } from 'node:path'; // No Bun equivalent for path utils
import { getIndexDbPath } from '../app/constants';
import { getConfigPaths, isInitialized, loadConfig } from '../config';
import { SqliteAdapter } from '../store/sqlite/adapter';
import { routeApi } from './routes/api';

// Resolve public directory relative to this file
const PUBLIC_DIR = join(dirname(import.meta.path), 'public');

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
  const paths = getConfigPaths();
  store.setConfigPath(paths.configFile);

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

  // CSP header for security
  const CSP_HEADER =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";

  const server = Bun.serve({
    port,
    hostname: '127.0.0.1', // Loopback only - no LAN exposure
    async fetch(req) {
      const url = new URL(req.url);

      // API routes
      const apiResponse = await routeApi(store, req, url);
      if (apiResponse) {
        // Add CSP header to API responses
        apiResponse.headers.set('Content-Security-Policy', CSP_HEADER);
        return apiResponse;
      }

      // Static files from public directory
      let filePath = url.pathname === '/' ? '/index.html' : url.pathname;

      // SPA routing: serve index.html for non-file routes
      if (!(filePath.includes('.') || filePath.startsWith('/api/'))) {
        filePath = '/index.html';
      }

      const file = Bun.file(join(PUBLIC_DIR, filePath));
      if (await file.exists()) {
        return new Response(file, {
          headers: { 'Content-Security-Policy': CSP_HEADER },
        });
      }

      // 404 for unknown routes
      return new Response('Not Found', {
        status: 404,
        headers: { 'Content-Security-Policy': CSP_HEADER },
      });
    },
  });

  console.log(`GNO server running at http://localhost:${server.port}`);
  console.log('Press Ctrl+C to stop');

  // Block forever - server runs until SIGINT/SIGTERM
  await new Promise(() => {});

  return { success: true };
}
