// node:fs/promises exposes symlink metadata; Bun.Glob does not.
import { lstat } from "node:fs/promises";
import { join } from "node:path";

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const FIXED_DOS_DATE = 0x0021; // 1980-01-01
const MAX_UINT32 = 0xffffffff;

export interface ArchiveEntry {
  path: string;
  bytes: Uint8Array;
}

const comparePaths = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const assertUint32 = (value: number, label: string): void => {
  if (!(Number.isInteger(value) && value >= 0 && value <= MAX_UINT32)) {
    throw new Error(`Browser clipper archive exceeds ZIP32 ${label}`);
  }
};

const concatBytes = (parts: Uint8Array[]): Uint8Array => {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

const encodePath = (path: string): Uint8Array => {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").includes("..")
  ) {
    throw new Error(`Unsafe browser clipper archive path: ${path}`);
  }
  const encoded = new TextEncoder().encode(path);
  if (encoded.byteLength > 0xffff) {
    throw new Error(`Browser clipper archive path is too long: ${path}`);
  }
  return encoded;
};

const localHeader = (
  path: Uint8Array,
  checksum: number,
  size: number
): Uint8Array => {
  const header = new Uint8Array(30);
  const view = new DataView(header.buffer);
  view.setUint32(0, LOCAL_FILE_SIGNATURE, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, FIXED_DOS_DATE, true);
  view.setUint32(14, checksum, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, path.byteLength, true);
  view.setUint16(28, 0, true);
  return header;
};

const centralHeader = (
  path: Uint8Array,
  checksum: number,
  size: number,
  localOffset: number
): Uint8Array => {
  const header = new Uint8Array(46);
  const view = new DataView(header.buffer);
  view.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, ZIP_VERSION, true);
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, FIXED_DOS_DATE, true);
  view.setUint32(16, checksum, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, path.byteLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localOffset, true);
  return header;
};

/** Build a portable ZIP32 archive with stored files and fixed metadata. */
export const createDeterministicZip = (
  inputEntries: ArchiveEntry[]
): Uint8Array => {
  const entries = [...inputEntries].sort((left, right) =>
    comparePaths(left.path, right.path)
  );
  if (
    entries.length > 0xffff ||
    new Set(entries.map(({ path }) => path)).size !== entries.length
  ) {
    throw new Error("Browser clipper archive has too many or duplicate files");
  }

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const path = encodePath(entry.path);
    assertUint32(entry.bytes.byteLength, "entry size");
    assertUint32(localOffset, "entry offset");
    const checksum = crc32(entry.bytes);
    const header = localHeader(path, checksum, entry.bytes.byteLength);
    localParts.push(header, path, entry.bytes);
    centralParts.push(
      centralHeader(path, checksum, entry.bytes.byteLength, localOffset),
      path
    );
    localOffset += header.byteLength + path.byteLength + entry.bytes.byteLength;
  }

  const centralDirectory = concatBytes(centralParts);
  assertUint32(localOffset, "central directory offset");
  assertUint32(centralDirectory.byteLength, "central directory size");
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectory.byteLength, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);
  return concatBytes([...localParts, centralDirectory, end]);
};

export const readArchiveEntries = (archive: Uint8Array): ArchiveEntry[] => {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength
  );
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  while (
    offset + 4 <= archive.byteLength &&
    view.getUint32(offset, true) === LOCAL_FILE_SIGNATURE
  ) {
    if (offset + 30 > archive.byteLength) {
      throw new Error("Truncated browser clipper ZIP local header");
    }
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const checksum = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const size = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if (
      flags !== UTF8_FLAG ||
      method !== 0 ||
      compressedSize !== size ||
      extraLength !== 0
    ) {
      throw new Error("Unsupported browser clipper ZIP entry encoding");
    }
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.byteLength) {
      throw new Error("Truncated browser clipper ZIP entry");
    }
    const path = new TextDecoder("utf-8", { fatal: true }).decode(
      archive.subarray(nameStart, dataStart)
    );
    encodePath(path);
    const bytes = archive.slice(dataStart, dataEnd);
    if (crc32(bytes) !== checksum) {
      throw new Error(`Browser clipper ZIP checksum mismatch: ${path}`);
    }
    entries.push({ path, bytes });
    offset = dataEnd;
  }
  if (
    offset + 4 > archive.byteLength ||
    view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE
  ) {
    throw new Error("Browser clipper ZIP is missing its central directory");
  }
  return entries;
};

export const readDirectoryEntries = async (
  directory: string
): Promise<ArchiveEntry[]> => {
  const glob = new Bun.Glob("**/*");
  const paths = [
    ...(await Array.fromAsync(
      glob.scan({ cwd: directory, dot: true, onlyFiles: true })
    )),
  ].sort(comparePaths);
  const entries: ArchiveEntry[] = [];
  for (const path of paths) {
    const absolutePath = join(directory, path);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Browser clipper package refuses symlink: ${path}`);
    }
    entries.push({
      path: path.replaceAll("\\", "/"),
      bytes: new Uint8Array(await Bun.file(absolutePath).arrayBuffer()),
    });
  }
  return entries;
};

export const sha256Hex = (bytes: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
};
