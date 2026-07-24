// node:fs/promises supplies atomic directory renames and structure operations.
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  createDeterministicZip,
  readDirectoryEntries,
  sha256Hex,
} from "./archive";
import { buildClipper } from "./build";
import { replaceDirectory } from "./filesystem";

interface PackageManifest {
  version: string;
}

export interface PackageClipperOptions {
  artifactsDir?: string;
  distDir?: string;
  rootDir?: string;
}

export interface ClipperPackageResult {
  archiveName: string;
  archivePath: string;
  checksum: string;
  checksumPath: string;
  distDir: string;
  version: string;
}

export const packageClipper = async (
  options: PackageClipperOptions = {}
): Promise<ClipperPackageResult> => {
  const rootDir = resolve(options.rootDir ?? import.meta.dir);
  const distDir = resolve(options.distDir ?? join(rootDir, "dist"));
  const artifactsDir = resolve(
    options.artifactsDir ?? join(rootDir, "artifacts")
  );
  await buildClipper({ outdir: distDir, rootDir });

  const packageManifest = (await Bun.file(
    join(rootDir, "..", "package.json")
  ).json()) as PackageManifest;
  const version = packageManifest.version;
  const archiveName = `gno-browser-clipper-v${version}.zip`;
  const archive = createDeterministicZip(await readDirectoryEntries(distDir));
  const checksum = sha256Hex(archive);
  const temporary = join(
    dirname(artifactsDir),
    `.${basename(artifactsDir)}-build-${process.pid}`
  );
  await rm(temporary, { force: true, recursive: true });
  await mkdir(temporary, { recursive: true });
  const archivePath = join(temporary, archiveName);
  const checksumPath = `${archivePath}.sha256`;
  try {
    await Bun.write(archivePath, archive);
    await Bun.write(checksumPath, `${checksum}  ${archiveName}\n`);
    await replaceDirectory(temporary, artifactsDir);
  } catch (error) {
    await rm(temporary, { force: true, recursive: true });
    throw error;
  }

  return {
    archiveName,
    archivePath: join(artifactsDir, archiveName),
    checksum,
    checksumPath: join(artifactsDir, `${archiveName}.sha256`),
    distDir,
    version,
  };
};
