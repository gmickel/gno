/**
 * Model cache resolver.
 * Handles hf: URI parsing and model cache management.
 *
 * @module src/llm/cache
 */

// node:crypto: createHash for safe lock filenames
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
// node:path: join for path construction, isAbsolute for cross-platform path detection
import { isAbsolute, join } from 'node:path';
// node:url: fileURLToPath for proper file:// URL handling
import { fileURLToPath } from 'node:url';
import { getModelsCachePath } from '../app/constants';
import {
  autoDownloadDisabledError,
  downloadFailedError,
  invalidUriError,
  lockFailedError,
  modelNotCachedError,
  modelNotFoundError,
} from './errors';
import { getLockPath, getManifestLockPath, withLock } from './lockfile';
import type { DownloadPolicy } from './policy';
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
 * - file:///path/to/model.gguf (standard file URL)
 * - file:///C:/path/to/model.gguf (Windows file URL)
 * - file:/path/to/model.gguf (simplified file URI)
 * - /path/to/model.gguf (Unix absolute path)
 * - C:\path\to\model.gguf (Windows absolute path)
 * - \\server\share\model.gguf (UNC path)
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

  // Handle file:// URLs (proper file URLs like file:///C:/path or file:///path)
  if (uri.startsWith('file://')) {
    try {
      const filePath = fileURLToPath(new URL(uri));
      return {
        ok: true,
        value: { scheme: 'file', file: filePath },
      };
    } catch {
      return { ok: false, error: `Invalid file URL: ${uri}` };
    }
  }

  // Handle simplified file: scheme (file:/path or file:C:\path)
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

  // Treat as local file path if absolute (works on both Unix and Windows)
  if (isAbsolute(uri)) {
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

interface Manifest {
  version: '1.0';
  models: ModelCacheEntry[];
}

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
    onProgress?: ProgressCallback,
    force?: boolean
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

    // Force: delete existing file to trigger re-download
    if (force) {
      const existingPath = await this.getCachedPath(uri);
      if (existingPath) {
        await rm(existingPath).catch(() => {
          // Ignore: file may not exist or already deleted
        });
      }
    }

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
   * Ensure a model is available, downloading if necessary.
   * Uses double-check locking pattern for concurrent safety.
   *
   * @param uri - Model URI (hf: or file:)
   * @param type - Model type for manifest
   * @param policy - Download policy (offline, allowDownload)
   * @param onProgress - Optional progress callback
   */
  async ensureModel(
    uri: string,
    type: ModelType,
    policy: DownloadPolicy,
    onProgress?: ProgressCallback
  ): Promise<LlmResult<string>> {
    // Fast path: check if already cached
    const cached = await this.getCachedPath(uri);
    if (cached) {
      return { ok: true, value: cached };
    }

    // Parse and validate URI
    const parsed = parseModelUri(uri);
    if (!parsed.ok) {
      return { ok: false, error: invalidUriError(uri, parsed.error) };
    }

    // Local files: just verify existence (no download needed)
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

    // HF models: check policy
    if (policy.offline) {
      return { ok: false, error: modelNotCachedError(uri, type) };
    }

    if (!policy.allowDownload) {
      return { ok: false, error: autoDownloadDisabledError(uri) };
    }

    // Acquire lock for download (prevents concurrent downloads of same model)
    // Use hash for lock filename to avoid collisions and path issues
    await mkdir(this.dir, { recursive: true });
    const lockName = createHash('sha256')
      .update(uri)
      .digest('hex')
      .slice(0, 32);
    const lockPath = getLockPath(join(this.dir, lockName));

    const result = await withLock(lockPath, async () => {
      // Double-check: another process may have downloaded while we waited
      const cachedNow = await this.getCachedPath(uri);
      if (cachedNow) {
        return { ok: true as const, value: cachedNow };
      }

      // Download with progress
      return this.download(uri, type, onProgress);
    });

    // withLock returns null if lock acquisition failed
    if (result === null) {
      return { ok: false, error: lockFailedError(uri) };
    }

    return result;
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
    // First, read manifest to get paths to delete (outside lock for IO)
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

    // Update manifest under lock
    await this.updateManifest((m) => {
      if (types) {
        m.models = m.models.filter((model) => !types.includes(model.type));
      } else {
        m.models = [];
      }
    });
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

    this.manifest = await this.readManifestFromDisk();
    return this.manifest;
  }

  /**
   * Read manifest from disk without cache (for use under lock).
   */
  private async readManifestFromDisk(): Promise<Manifest> {
    try {
      const content = await readFile(this.manifestPath, 'utf-8');
      return JSON.parse(content) as Manifest;
    } catch {
      // No manifest or invalid - create empty
      return { version: MANIFEST_VERSION, models: [] };
    }
  }

  /**
   * Atomically update manifest under lock.
   * Uses read-modify-write pattern with cross-process locking to prevent lost updates.
   */
  private async updateManifest(
    mutator: (manifest: Manifest) => void
  ): Promise<void> {
    await mkdir(this.dir, { recursive: true });

    const lockPath = getManifestLockPath(this.dir);
    const result = await withLock(lockPath, async () => {
      // Read current manifest from disk (not cache) under lock
      const manifest = await this.readManifestFromDisk();

      // Apply mutation
      mutator(manifest);

      // Write atomically
      await this.writeManifestAtomically(manifest);

      // Update cache
      this.manifest = manifest;
      return true;
    });

    if (result === null) {
      throw new Error('Failed to acquire manifest lock');
    }
  }

  /**
   * Atomically write manifest with fsync for durability.
   * Uses write-to-temp + fsync + rename pattern.
   * Must be called under manifest lock.
   */
  private async writeManifestAtomically(manifest: Manifest): Promise<void> {
    const tmpPath = `${this.manifestPath}.${process.pid}.tmp`;
    const content = JSON.stringify(manifest, null, 2);

    // Write to temp file with fsync
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }

    // Atomic rename
    await rename(tmpPath, this.manifestPath);

    // Fsync parent directory for rename durability (best-effort, not supported on Windows)
    if (process.platform !== 'win32') {
      try {
        const dirFh = await open(this.dir, 'r');
        try {
          await dirFh.sync();
        } finally {
          await dirFh.close();
        }
      } catch {
        // Best-effort durability
      }
    }
  }

  private async addToManifest(
    uri: string,
    type: ModelType,
    modelPath: string
  ): Promise<void> {
    // Get file size outside lock (IO-bound, doesn't need protection)
    let size = 0;
    try {
      const stats = await stat(modelPath);
      size = stats.size;
    } catch {
      // Ignore
    }

    await this.updateManifest((manifest) => {
      // Remove existing entry if present
      manifest.models = manifest.models.filter((m) => m.uri !== uri);

      // Add new entry
      manifest.models.push({
        uri,
        type,
        path: modelPath,
        size,
        checksum: '', // TODO: compute SHA-256 for large files
        cachedAt: new Date().toISOString(),
      });
    });
  }

  private async removeFromManifest(uri: string): Promise<void> {
    await this.updateManifest((manifest) => {
      manifest.models = manifest.models.filter((m) => m.uri !== uri);
    });
  }
}
