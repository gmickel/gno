/**
 * Model cache resolver.
 * Handles hf: URI parsing and model cache management.
 *
 * @module src/llm/cache
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getModelsCachePath } from '../app/constants';
import {
  downloadFailedError,
  invalidUriError,
  modelNotCachedError,
  modelNotFoundError,
} from './errors';
import type {
  DownloadProgress,
  LlmResult,
  ModelCacheEntry,
  ModelType,
  ProgressCallback,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// URI Parsing
// ─────────────────────────────────────────────────────────────────────────────

// Regex patterns for URI parsing (top-level for performance)
const HF_QUANT_PATTERN = /^([^/]+)\/([^/:]+):(\w+)$/;
const HF_PATH_PATTERN = /^([^/]+)\/([^/]+)\/(.+\.gguf)$/;

export type ParsedModelUri =
  | {
      scheme: 'hf';
      org: string;
      repo: string;
      file: string;
      quantization?: string;
    }
  | {
      scheme: 'file';
      file: string;
    };

/**
 * Parse a model URI into components.
 *
 * Supported formats:
 * - hf:org/repo/file.gguf (explicit file)
 * - hf:org/repo:Q4_K_M (quantization shorthand - infers filename)
 * - file:/path/to/model.gguf (local file)
 * - /path/to/model.gguf (implicit file: scheme)
 */
export function parseModelUri(
  uri: string
): { ok: true; value: ParsedModelUri } | { ok: false; error: string } {
  // Handle hf: scheme
  if (uri.startsWith('hf:')) {
    const rest = uri.slice(3);

    // Check for quantization shorthand: hf:org/repo:Q4_K_M
    const colonMatch = rest.match(HF_QUANT_PATTERN);
    if (colonMatch) {
      const [, org, repo, quant] = colonMatch;
      // Regex guarantees these are defined when match succeeds
      if (org && repo && quant) {
        return {
          ok: true,
          value: {
            scheme: 'hf',
            org,
            repo,
            file: '', // Will be resolved by node-llama-cpp
            quantization: quant,
          },
        };
      }
    }

    // Full path: hf:org/repo/file.gguf
    const pathMatch = rest.match(HF_PATH_PATTERN);
    if (pathMatch) {
      const [, org, repo, file] = pathMatch;
      // Regex guarantees these are defined when match succeeds
      if (org && repo && file) {
        return {
          ok: true,
          value: {
            scheme: 'hf',
            org,
            repo,
            file,
          },
        };
      }
    }

    return { ok: false, error: `Invalid hf: URI format: ${uri}` };
  }

  // Handle file: scheme or absolute path
  if (uri.startsWith('file:')) {
    const path = uri.slice(5);
    if (!path) {
      return { ok: false, error: 'Empty file path' };
    }
    return {
      ok: true,
      value: { scheme: 'file', file: path },
    };
  }

  // Treat as local file path if starts with /
  if (uri.startsWith('/')) {
    return {
      ok: true,
      value: { scheme: 'file', file: uri },
    };
  }

  return { ok: false, error: `Unknown URI scheme: ${uri}` };
}

/**
 * Convert parsed URI back to node-llama-cpp format.
 */
export function toNodeLlamaCppUri(parsed: ParsedModelUri): string {
  if (parsed.scheme === 'file') {
    return parsed.file;
  }

  // hf: format for node-llama-cpp
  if (parsed.quantization) {
    return `hf:${parsed.org}/${parsed.repo}:${parsed.quantization}`;
  }
  return `hf:${parsed.org}/${parsed.repo}/${parsed.file}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────────────

type Manifest = {
  version: '1.0';
  models: ModelCacheEntry[];
};

const MANIFEST_VERSION = '1.0' as const;

// ─────────────────────────────────────────────────────────────────────────────
// ModelCache
// ─────────────────────────────────────────────────────────────────────────────

export class ModelCache {
  readonly dir: string;
  private readonly manifestPath: string;
  private manifest: Manifest | null = null;

  constructor(cacheDir?: string) {
    this.dir = cacheDir ?? getModelsCachePath();
    this.manifestPath = join(this.dir, 'manifest.json');
  }

  /**
   * Resolve a model URI to a local file path.
   * Returns error if not cached.
   */
  async resolve(uri: string, type: ModelType): Promise<LlmResult<string>> {
    const parsed = parseModelUri(uri);
    if (!parsed.ok) {
      return { ok: false, error: invalidUriError(uri, parsed.error) };
    }

    // Local files: verify existence
    if (parsed.value.scheme === 'file') {
      const exists = await this.fileExists(parsed.value.file);
      if (!exists) {
        return {
          ok: false,
          error: modelNotFoundError(
            uri,
            `File not found: ${parsed.value.file}`
          ),
        };
      }
      return { ok: true, value: parsed.value.file };
    }

    // HF models: check cache
    const cached = await this.getCachedPath(uri);
    if (cached) {
      return { ok: true, value: cached };
    }

    return { ok: false, error: modelNotCachedError(uri, type) };
  }

  /**
   * Download a model to the cache.
   * Uses node-llama-cpp's resolveModelFile for HF models.
   */
  async download(
    uri: string,
    type: ModelType,
    onProgress?: ProgressCallback
  ): Promise<LlmResult<string>> {
    const parsed = parseModelUri(uri);
    if (!parsed.ok) {
      return { ok: false, error: invalidUriError(uri, parsed.error) };
    }

    // Local files: just verify
    if (parsed.value.scheme === 'file') {
      const exists = await this.fileExists(parsed.value.file);
      if (!exists) {
        return {
          ok: false,
          error: modelNotFoundError(
            uri,
            `File not found: ${parsed.value.file}`
          ),
        };
      }
      return { ok: true, value: parsed.value.file };
    }

    // Ensure cache dir exists
    await mkdir(this.dir, { recursive: true });

    try {
      const { resolveModelFile } = await import('node-llama-cpp');

      // Convert to node-llama-cpp format (handles quantization shorthand)
      // node-llama-cpp needs hf: prefix to identify HuggingFace models
      const hfUri = toNodeLlamaCppUri(parsed.value);

      const resolvedPath = await resolveModelFile(hfUri, {
        directory: this.dir,
        onProgress: onProgress
          ? (status: unknown) => {
              // Type-safe check for download progress status
              if (
                status &&
                typeof status === 'object' &&
                'type' in status &&
                status.type === 'download' &&
                'downloadedSize' in status &&
                'totalSize' in status
              ) {
                const s = status as {
                  downloadedSize: number;
                  totalSize: number;
                };
                const progress: DownloadProgress = {
                  downloadedBytes: s.downloadedSize,
                  totalBytes: s.totalSize,
                  percent:
                    s.totalSize > 0
                      ? (s.downloadedSize / s.totalSize) * 100
                      : 0,
                };
                onProgress(progress);
              }
            }
          : undefined,
      });

      // Update manifest
      await this.addToManifest(uri, type, resolvedPath);

      return { ok: true, value: resolvedPath };
    } catch (e) {
      return { ok: false, error: downloadFailedError(uri, e) };
    }
  }

  /**
   * Check if a model is cached/available.
   * For file: URIs, checks if file exists on disk.
   * For hf: URIs, checks the manifest.
   */
  async isCached(uri: string): Promise<boolean> {
    const cached = await this.getCachedPath(uri);
    return cached !== null;
  }

  /**
   * Get cached/available path for a URI.
   * For file: URIs, returns path if file exists.
   * For hf: URIs, checks the manifest.
   */
  async getCachedPath(uri: string): Promise<string | null> {
    // Handle file: URIs directly (check filesystem, not manifest)
    const parsed = parseModelUri(uri);
    if (parsed.ok && parsed.value.scheme === 'file') {
      const exists = await this.fileExists(parsed.value.file);
      return exists ? parsed.value.file : null;
    }

    // HF URIs: check manifest
    const manifest = await this.loadManifest();
    const entry = manifest.models.find((m) => m.uri === uri);
    if (!entry) {
      return null;
    }

    // Verify file still exists
    const exists = await this.fileExists(entry.path);
    if (!exists) {
      // Remove stale entry
      await this.removeFromManifest(uri);
      return null;
    }

    return entry.path;
  }

  /**
   * List all cached models.
   */
  async list(): Promise<ModelCacheEntry[]> {
    const manifest = await this.loadManifest();
    return manifest.models;
  }

  /**
   * Get total size of all cached models.
   */
  async totalSize(): Promise<number> {
    const manifest = await this.loadManifest();
    return manifest.models.reduce((sum, m) => sum + (m.size || 0), 0);
  }

  /**
   * Clear cached models.
   * If types provided, only clears models of those types.
   */
  async clear(types?: ModelType[]): Promise<void> {
    const manifest = await this.loadManifest();

    const toRemove = types
      ? manifest.models.filter((m) => types.includes(m.type))
      : manifest.models;

    for (const entry of toRemove) {
      try {
        await rm(entry.path, { force: true });
      } catch {
        // Ignore deletion errors
      }
    }

    // Update manifest
    if (types) {
      manifest.models = manifest.models.filter((m) => !types.includes(m.type));
    } else {
      manifest.models = [];
    }

    await this.saveManifest(manifest);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private
  // ───────────────────────────────────────────────────────────────────────────

  private async fileExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async loadManifest(): Promise<Manifest> {
    if (this.manifest) {
      return this.manifest;
    }

    try {
      const content = await readFile(this.manifestPath, 'utf-8');
      this.manifest = JSON.parse(content) as Manifest;
      return this.manifest;
    } catch {
      // No manifest or invalid - create empty
      this.manifest = { version: MANIFEST_VERSION, models: [] };
      return this.manifest;
    }
  }

  private async saveManifest(manifest: Manifest): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.manifestPath, JSON.stringify(manifest, null, 2));
    this.manifest = manifest;
  }

  private async addToManifest(
    uri: string,
    type: ModelType,
    path: string
  ): Promise<void> {
    const manifest = await this.loadManifest();

    // Get file size and compute checksum
    let size = 0;
    try {
      const stats = await stat(path);
      size = stats.size;
    } catch {
      // Ignore
    }

    // Remove existing entry if present
    manifest.models = manifest.models.filter((m) => m.uri !== uri);

    // Add new entry
    manifest.models.push({
      uri,
      type,
      path,
      size,
      checksum: '', // TODO: compute SHA-256 for large files
      cachedAt: new Date().toISOString(),
    });

    await this.saveManifest(manifest);
  }

  private async removeFromManifest(uri: string): Promise<void> {
    const manifest = await this.loadManifest();
    manifest.models = manifest.models.filter((m) => m.uri !== uri);
    await this.saveManifest(manifest);
  }
}
