/**
 * Synchronous SHA-256 + base64 helpers for publish assets.
 * Bun.CryptoHasher for digests; browser-safe atob for base64 decode parity with gno.sh.
 *
 * @module src/publish/artifact-asset-codec
 */

/** Synchronous SHA-256 hex digest over raw bytes (Bun-native). */
export const sha256BytesHex = (bytes: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
};

const BASE64_PATTERN =
  /^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/u;

/**
 * Encode raw bytes to standard base64 without Node Buffer.
 * Prefers Bun/Web Uint8Array.toBase64(); falls back to btoa for parity with decode.
 */
export const encodeBytesToBase64 = (bytes: Uint8Array): string => {
  if (typeof bytes.toBase64 === "function") {
    return bytes.toBase64();
  }
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const slice = bytes.subarray(offset, offset + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
};

/** Decode standard base64 without Buffer (uses atob). */
export const decodeBase64ToBytes = (
  data: string
): { ok: true; bytes: Uint8Array } | { ok: false } => {
  if (!BASE64_PATTERN.test(data) || data.length === 0) return { ok: false };
  try {
    const binary = atob(data);
    if (binary.length === 0 && data.replace(/=+$/u, "").length > 0) {
      return { ok: false };
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false };
  }
};

const UTF8 = new TextEncoder();

export const measureSerializedUploadBytes = (serializedBody: string): number =>
  UTF8.encode(serializedBody).byteLength;

/**
 * Canonical on-disk/upload serialization for publish artifacts.
 *
 * Byte-budget enforcement and every artifact writer must use this exact
 * representation so `finalUploadBytes` describes the bytes handed to gno.sh.
 */
export const serializePublishArtifact = (artifact: unknown): string => {
  const serialized = JSON.stringify(artifact, null, 2);
  if (serialized === undefined) {
    throw new TypeError("Publish artifact is not JSON-serializable");
  }
  return serialized;
};

export const measureArtifactUploadBytes = (artifact: unknown): number =>
  measureSerializedUploadBytes(serializePublishArtifact(artifact));
