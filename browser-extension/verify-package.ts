// node:fs/promises supplies temporary structure and cleanup operations.
import { mkdtemp, rm } from "node:fs/promises";
// node:os exposes the platform temporary directory.
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readArchiveEntries, readDirectoryEntries, sha256Hex } from "./archive";
import { packageClipper } from "./package";

interface Snapshot {
  path: string;
  sha256: string;
}

const snapshotDirectory = async (directory: string): Promise<Snapshot[]> =>
  (await readDirectoryEntries(directory)).map(({ bytes, path }) => ({
    path,
    sha256: sha256Hex(bytes),
  }));

const tempRoot = await mkdtemp(join(tmpdir(), "gno-clipper-repro-"));
try {
  const runs = await Promise.all(
    ["first", "second"].map(async (name) => {
      const root = join(tempRoot, name);
      const result = await packageClipper({
        artifactsDir: join(root, "artifacts"),
        distDir: join(root, "dist"),
      });
      const archive = new Uint8Array(
        await Bun.file(result.archivePath).arrayBuffer()
      );
      const archivedEntries = readArchiveEntries(archive);
      return {
        result,
        archive,
        checksumText: await Bun.file(result.checksumPath).text(),
        dist: await snapshotDirectory(result.distDir),
        archived: archivedEntries.map(({ bytes, path }) => ({
          path,
          sha256: sha256Hex(bytes),
        })),
      };
    })
  );
  const [first, second] = runs;
  if (!(first && second)) {
    throw new Error("Browser clipper reproducibility runs did not complete");
  }
  if (
    !Bun.deepEquals(first.archive, second.archive, true) ||
    first.checksumText !== second.checksumText ||
    !Bun.deepEquals(first.dist, second.dist, true) ||
    !Bun.deepEquals(first.dist, first.archived, true) ||
    !Bun.deepEquals(second.dist, second.archived, true)
  ) {
    throw new Error("Browser clipper clean builds are not byte-reproducible");
  }
  const manifest = (await Bun.file(
    join(first.result.distDir, "manifest.json")
  ).json()) as { version?: unknown };
  if (manifest.version !== first.result.version) {
    throw new Error("Browser clipper manifest and artifact versions differ");
  }
  console.log(
    `Browser clipper reproducibility passed: ${first.result.archiveName} ${first.result.checksum}`
  );
} finally {
  await rm(tempRoot, { force: true, recursive: true });
}
