/**
 * Shared raster fixtures and temp-root helpers for publish attachment tests.
 *
 * @module test/publish/helpers/attachment-fixtures
 */

// node:fs/promises mkdir/rm/writeFile — structural ops; no Bun equivalent
import { mkdir, rm, writeFile } from "node:fs/promises";
// node:os tmpdir — no Bun equivalent
import { tmpdir } from "node:os";
// node:path dirname/join — no Bun path utils
import { dirname, join } from "node:path";

export const PNG_1X1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  ),
  (c) => c.charCodeAt(0)
);

/** Minimal JPEG SOF0 1x1. */
export const JPEG_1X1 = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00,
  0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
]);

export const GIF_1X1 = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x3b,
]);

/** VP8X canvas 1x1 WebP. */
export const WEBP_1X1 = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
  0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);

export const writeU32BE = (value: number): Uint8Array =>
  Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  );

export const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

export const bmffBox = (
  type: string,
  payload: Uint8Array,
  options: { fullBox?: boolean } = {}
): Uint8Array => {
  const typeBytes = new TextEncoder().encode(type);
  const versionFlags = options.fullBox ? Uint8Array.of(0, 0, 0, 0) : null;
  const size = 8 + (versionFlags?.length ?? 0) + payload.length;
  return concatBytes(
    writeU32BE(size),
    typeBytes,
    versionFlags ?? new Uint8Array(0),
    payload
  );
};

/** Synthetic AVIF: ftyp + meta(FullBox) > iprp > ipco > ispe(FullBox). */
export const buildAvif = (width: number, height: number): Uint8Array => {
  const ispe = bmffBox(
    "ispe",
    concatBytes(writeU32BE(width), writeU32BE(height)),
    { fullBox: true }
  );
  const ipco = bmffBox("ipco", ispe);
  const iprp = bmffBox("iprp", ipco);
  const meta = bmffBox("meta", iprp, { fullBox: true });
  const ftyp = bmffBox(
    "ftyp",
    concatBytes(
      new TextEncoder().encode("avif"),
      writeU32BE(0),
      new TextEncoder().encode("avif")
    )
  );
  return concatBytes(ftyp, meta);
};

export const AVIF_1X1 = buildAvif(1, 1);

const roots: string[] = [];

export const makeRoot = async (): Promise<string> => {
  const root = join(
    tmpdir(),
    `gno-attach-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await mkdir(root, { recursive: true });
  roots.push(root);
  return root;
};

/** Remove temp roots created by `makeRoot`. Call from each suite's `afterEach`. */
export const cleanupAttachmentRoots = async (): Promise<void> => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (!root) continue;
    await rm(root, { recursive: true, force: true });
  }
};

export const writeBytes = async (
  path: string,
  bytes: Uint8Array
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
};
