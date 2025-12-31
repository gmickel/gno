/**
 * Bun.serve() web server for GNO web UI.
 * Uses Bun's fullstack dev server with HTML imports.
 * Opens DB once at startup, closes on shutdown.
 *
 * @module src/serve/server
 */

import { join } from 'node:path'; // no Bun path utils
import { getIndexDbPath } from '../app/constants';
import { getConfigPaths, isInitialized, loadConfig } from '../config';
import { SqliteAdapter } from '../store/sqlite/adapter';
import { routeApi } from './routes/api';

// Frontend directories
const PUBLIC_DIR = join(import.meta.dir, 'public');
const DIST_DIR = join(import.meta.dir, 'dist');

/**
 * Build frontend if dist doesn't exist.
 */
async function ensureFrontendBuilt(): Promise<void> {
  const indexHtml = Bun.file(join(DIST_DIR, 'index.html'));
  if (await indexHtml.exists()) return;

  console.log('Building frontend...');
  const result = await Bun.build({
    entrypoints: [join(PUBLIC_DIR, 'index.html')],
    outdir: DIST_DIR,
    minify: true,
  });

  if (!result.success) {
    throw new Error(`Frontend build failed: ${result.logs.join('\n')}`);
  }
  console.log('Frontend built successfully');
}

export interface ServeOptions {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Config path override */
  configPath?: string;
  /** Index name (from --index flag) */
  index?: string;
}

export interface ServeResult {
  success: boolean;
  error?: string;
}

/**
 * Parse hostname from Host header, handling IPv6 brackets.
 * Examples: "localhost:3000" -> "localhost", "[::1]:3000" -> "::1"
 */
function parseHostname(host: string): string {
  if (host.startsWith('[')) {
    // IPv6 with brackets: [::1]:3000 or [::1]
    const bracketEnd = host.indexOf(']');
    if (bracketEnd > 0) {
      return host.slice(1, bracketEnd); // Strip brackets
    }
  }
  // IPv4 or hostname: localhost:3000 or 127.0.0.1:3000
  const colonIdx = host.indexOf(':');
  return colonIdx > 0 ? host.slice(0, colonIdx) : host;
}

/**
 * Check if hostname is a valid loopback address.
 * Supports IPv4 (127.0.0.1, localhost) and IPv6 (::1).
 */
function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/**
 * Get CSP based on environment.
 * Dev mode allows WebSocket connections for HMR.
 */
function getCspHeader(isDev: boolean): string {
  // Local fonts only - no Google Fonts for true offline-first
  const base = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'", // Prevent base tag injection
    "object-src 'none'", // Prevent plugin execution
  ];

  // Dev mode: allow WebSocket for HMR
  if (isDev) {
    base.push("connect-src 'self' ws:");
  } else {
    base.push("connect-src 'self'");
  }

  return base.join('; ');
}

/**
 * Apply security headers to a Response.
 */
function withSecurityHeaders(response: Response, isDev: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', getCspHeader(isDev));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Start the web server.
 * Opens DB once, closes on SIGINT/SIGTERM.
 */
export async function startServer(
  options: ServeOptions = {}
): Promise<ServeResult> {
  const port = options.port ?? 3000;
  const isDev = process.env.NODE_ENV !== 'production';

  // Build frontend if needed
  try {
    await ensureFrontendBuilt();
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
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
  const dbPath = getIndexDbPath(options.index);
  // Use actual config path (from options or default) for consistency
  const paths = getConfigPaths();
  const actualConfigPath = options.configPath ?? paths.configFile;
  store.setConfigPath(actualConfigPath);

  const openResult = await store.open(dbPath, config.ftsTokenizer);
  if (!openResult.ok) {
    return { success: false, error: openResult.error.message };
  }

  // Shutdown controller for clean lifecycle
  const shutdownController = new AbortController();

  // Graceful shutdown handler
  const shutdown = async () => {
    console.log('\nShutting down...');
    await store.close();
    shutdownController.abort();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // Start server with try/catch for port-in-use etc.
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname: '127.0.0.1', // Loopback only - no LAN exposure

      // Enable development mode for console logging
      development: isDev,

      async fetch(req) {
        const url = new URL(req.url);

        // Validate Host header for DNS rebinding protection
        const host = req.headers.get('host') ?? '';
        const hostname = parseHostname(host);
        if (hostname && !isLoopback(hostname)) {
          return withSecurityHeaders(
            new Response('Forbidden', { status: 403 }),
            isDev
          );
        }

        // API routes
        const apiResponse = await routeApi(store, req, url);
        if (apiResponse) {
          return withSecurityHeaders(apiResponse, isDev);
        }

        // SPA routes - serve index.html
        if (
          url.pathname === '/' ||
          url.pathname === '/search' ||
          url.pathname === '/browse' ||
          url.pathname === '/doc'
        ) {
          const html = Bun.file(join(DIST_DIR, 'index.html'));
          return withSecurityHeaders(
            new Response(html, {
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            }),
            isDev
          );
        }

        // Static assets from dist directory
        const assetPath = join(DIST_DIR, url.pathname);
        const assetFile = Bun.file(assetPath);
        if (await assetFile.exists()) {
          return withSecurityHeaders(new Response(assetFile), isDev);
        }

        // 404 for unknown routes
        return withSecurityHeaders(
          new Response('Not Found', { status: 404 }),
          isDev
        );
      },
    });
  } catch (e) {
    await store.close();
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  console.log(`GNO server running at http://localhost:${server.port}`);
  console.log('Press Ctrl+C to stop');

  // Block until shutdown signal
  await new Promise<void>((resolve) => {
    shutdownController.signal.addEventListener('abort', () => resolve(), {
      once: true,
    });
  });

  server.stop(true);
  return { success: true };
}
