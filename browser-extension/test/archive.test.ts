import { describe, expect, test } from "bun:test";

import {
  createDeterministicZip,
  crc32,
  readArchiveEntries,
  sha256Hex,
} from "../archive";

const encoder = new TextEncoder();

describe("deterministic browser clipper ZIP", () => {
  test("sorts files, fixes metadata, and round-trips stored bytes", () => {
    const entries = [
      { path: "z.txt", bytes: encoder.encode("last") },
      { path: "nested/a.txt", bytes: encoder.encode("first") },
    ];
    const first = createDeterministicZip(entries);
    const second = createDeterministicZip([...entries].reverse());

    expect(first).toEqual(second);
    expect(sha256Hex(first)).toHaveLength(64);
    expect(
      readArchiveEntries(first).map(({ bytes, path }) => [
        path,
        new TextDecoder().decode(bytes),
      ])
    ).toEqual([
      ["nested/a.txt", "first"],
      ["z.txt", "last"],
    ]);

    const header = new DataView(
      first.buffer,
      first.byteOffset,
      first.byteLength
    );
    expect(header.getUint16(10, true)).toBe(0);
    expect(header.getUint16(12, true)).toBe(0x0021);
  });

  test("uses standard CRC-32 and rejects unsafe or duplicate paths", () => {
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
    expect(() =>
      createDeterministicZip([{ path: "../escape", bytes: new Uint8Array() }])
    ).toThrow("Unsafe browser clipper archive path");
    expect(() =>
      createDeterministicZip([
        { path: "same", bytes: new Uint8Array() },
        { path: "same", bytes: new Uint8Array() },
      ])
    ).toThrow("too many or duplicate");
  });

  test("fails closed when archived bytes no longer match their CRC", () => {
    const archive = createDeterministicZip([
      { path: "manifest.json", bytes: encoder.encode("{}") },
    ]);
    archive[archive.indexOf(0x7b)] = 0x5b;
    expect(() => readArchiveEntries(archive)).toThrow("checksum mismatch");
  });
});
