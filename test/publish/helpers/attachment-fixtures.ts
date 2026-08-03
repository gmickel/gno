/**
 * Shared raster fixtures and temp-root helpers for publish attachment tests.
 *
 * @module test/publish/helpers/attachment-fixtures
 */

// node:fs/promises mkdir/rm/writeFile — structural ops; no Bun equivalent
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

/** Complete, decoder-produced one-pixel fixtures (not header-only mocks). */
export const JPEG_1X1 = fromBase64(
  "/9j//gAPTGF2YzYxLjMuMTAwAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAE0AAQEAAAAAAAAAAAAAAAAAAAAGAQEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAABAAEDARIAAhIAAxIA/9oADAMBAAIRAxEAPwCLEoN/H//Z"
);

export const GIF_1X1 = fromBase64(
  "R0lGODlhAQABAPcfAAAAACQAAEgAAGwAAJAAALQAANgAAPwAAAAkACQkAEgkAGwkAJAkALQkANgkAPwkAABIACRIAEhIAGxIAJBIALRIANhIAPxIAABsACRsAEhsAGxsAJBsALRsANhsAPxsAACQACSQAEiQAGyQAJCQALSQANiQAPyQAAC0ACS0AEi0AGy0AJC0ALS0ANi0APy0AADYACTYAEjYAGzYAJDYALTYANjYAPzYAAD8ACT8AEj8AGz8AJD8ALT8ANj8APz8AAAAVSQAVUgAVWwAVZAAVbQAVdgAVfwAVQAkVSQkVUgkVWwkVZAkVbQkVdgkVfwkVQBIVSRIVUhIVWxIVZBIVbRIVdhIVfxIVQBsVSRsVUhsVWxsVZBsVbRsVdhsVfxsVQCQVSSQVUiQVWyQVZCQVbSQVdiQVfyQVQC0VSS0VUi0VWy0VZC0VbS0Vdi0Vfy0VQDYVSTYVUjYVWzYVZDYVbTYVdjYVfzYVQD8VST8VUj8VWz8VZD8VbT8Vdj8Vfz8VQAAqiQAqkgAqmwAqpAAqrQAqtgAqvwAqgAkqiQkqkgkqmwkqpAkqrQkqtgkqvwkqgBIqiRIqkhIqmxIqpBIqrRIqthIqvxIqgBsqiRsqkhsqmxsqpBsqrRsqthsqvxsqgCQqiSQqkiQqmyQqpCQqrSQqtiQqvyQqgC0qiS0qki0qmy0qpC0qrS0qti0qvy0qgDYqiTYqkjYqmzYqpDYqrTYqtjYqvzYqgD8qiT8qkj8qmz8qpD8qrT8qtj8qvz8qgAA/yQA/0gA/2wA/5AA/7QA/9gA//wA/wAk/yQk/0gk/2wk/5Ak/7Qk/9gk//wk/wBI/yRI/0hI/2xI/5BI/7RI/9hI//xI/wBs/yRs/0hs/2xs/5Bs/7Rs/9hs//xs/wCQ/ySQ/0iQ/2yQ/5CQ/7SQ/9iQ//yQ/wC0/yS0/0i0/2y0/5C0/7S0/9i0//y0/wDY/yTY/0jY/2zY/5DY/7TY/9jY//zY/wD8/yT8/0j8/2z8/5D8/7T8/9j8//z8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEBAAfACwAAAAAAQABAAAIBAAPBAQAOw=="
);

export const WEBP_1X1 = fromBase64(
  "UklGRlgAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAf1ZQOCAwAAAA0AEAnQEqAQABAAIANCWgAnS6AfgAA7AA/vDEC/8guWF1yNf/ID/kB/yA//jyAAAA"
);

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

/** Synthetic AVIF builder for structural-only malformed/dimension cases (not AV1-decodable). */
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
  return concatBytes(ftyp, meta, bmffBox("mdat", Uint8Array.of(0)));
};

export const AVIF_1X1 = fromBase64(
  "AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUEAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAfAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAABAAAAAQAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EgAAAAAAATY29scm5jbHgAAgACAACAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAnbWRhdAoHOAAG0BDQAjIUGAAAAFAAAAAF9e9k3XMB45obYdg="
);

const roots: string[] = [];

export const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "gno-attach-"));
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
