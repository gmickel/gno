import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises supplies temporary structure and cleanup operations.
import { mkdtemp } from "node:fs/promises";
// node:os exposes the platform temporary directory.
import { tmpdir } from "node:os";
import { join } from "node:path";

import { safeRm } from "../../test/helpers/cleanup";
import { readArchiveEntries, sha256Hex } from "../archive";
import { packageClipper } from "../package";

let tempRoot: string | null = null;

afterEach(async () => {
  if (tempRoot) {
    await safeRm(tempRoot);
    tempRoot = null;
  }
});

describe("browser clipper package", () => {
  test("emits non-empty version-matched unpacked, archive, and checksum outputs", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "gno-clipper-package-test-"));
    const result = await packageClipper({
      artifactsDir: join(tempRoot, "artifacts"),
      distDir: join(tempRoot, "dist"),
    });
    const packageManifest = (await Bun.file(
      join(import.meta.dir, "..", "..", "package.json")
    ).json()) as { version: string };
    const extensionManifest = (await Bun.file(
      join(result.distDir, "manifest.json")
    ).json()) as { version: string };
    const archive = new Uint8Array(
      await Bun.file(result.archivePath).arrayBuffer()
    );
    const checksum = await Bun.file(result.checksumPath).text();

    expect(extensionManifest.version).toBe(packageManifest.version);
    expect(result.archiveName).toBe(
      `gno-browser-clipper-v${packageManifest.version}.zip`
    );
    expect(archive.byteLength).toBeGreaterThan(1_000);
    expect(checksum).toBe(`${sha256Hex(archive)}  ${result.archiveName}\n`);
    expect(readArchiveEntries(archive).map(({ path }) => path)).toContain(
      "manifest.json"
    );
    expect(Bun.file(join(result.distDir, "PRIVACY.md")).size).toBeGreaterThan(
      1_000
    );
  });
});
