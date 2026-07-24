/** Installed npm-package proof for the reproducible browser clipper artifact. */

// node:fs/promises supplies temp structure and cleanup operations.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os exposes the platform temporary directory.
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  readArchiveEntries,
  readDirectoryEntries,
  sha256Hex,
} from "../browser-extension/archive";
import { safeRm } from "../test/helpers/cleanup";
import {
  assertPackageSmokePathContained,
  buildPackageSmokeProcessEnv,
} from "./package-smoke-isolation";
import {
  snapshotUserGnoState,
  verifyUserGnoStateUnchanged,
} from "./package-smoke-user-sentinel";

interface PackageManifest {
  name: string;
  version: string;
}

interface ExtensionManifest {
  content_scripts?: unknown;
  content_security_policy?: {
    extension_pages?: unknown;
  };
  externally_connectable?: unknown;
  host_permissions?: unknown;
  manifest_version?: unknown;
  permissions?: unknown;
  version?: unknown;
}

interface NpmPackResult {
  filename: string;
}

export interface VerifyPackedClipperOptions {
  packageRoot: string;
  tempRoot: string;
}

interface CommandResult {
  stderr: string;
  stdout: string;
}

const requiredDistFiles = [
  "PRIVACY.md",
  "manifest.json",
  "preview.html",
  "content.js",
  "service-worker.js",
];

const runCommand = (
  command: string[],
  cwd: string,
  env: Record<string, string>
): CommandResult => {
  const result = Bun.spawnSync(command, {
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = result.stdout ? new TextDecoder().decode(result.stdout) : "";
  const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : "";
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${result.exitCode}): ${command.join(" ")}\n${stdout}\n${stderr}`
    );
  }
  return { stderr, stdout };
};

const parseNpmPackOutput = (stdout: string): NpmPackResult => {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  const payload =
    start >= 0 && end > start ? stdout.slice(start, end + 1) : stdout;
  const parsed = JSON.parse(payload) as NpmPackResult[];
  const first = parsed[0];
  if (!first?.filename) {
    throw new Error("npm pack did not return a package filename");
  }
  return first;
};

const assertExtensionManifest = (
  manifest: ExtensionManifest,
  version: string
): void => {
  if (
    manifest.manifest_version !== 3 ||
    manifest.version !== version ||
    !Bun.deepEquals(
      manifest.permissions,
      ["activeTab", "scripting", "storage"],
      true
    ) ||
    !Bun.deepEquals(manifest.host_permissions, ["http://127.0.0.1/*"], true) ||
    manifest.content_scripts !== undefined ||
    manifest.externally_connectable !== undefined ||
    manifest.content_security_policy?.extension_pages !==
      "script-src 'self'; object-src 'none'; connect-src http://127.0.0.1:*"
  ) {
    throw new Error(
      "Packed browser clipper manifest version or permissions are invalid"
    );
  }
};

const assertNoBuildLeakage = async (
  directory: string,
  entries: Awaited<ReturnType<typeof readDirectoryEntries>>
): Promise<void> => {
  const forbiddenPaths = [resolve(directory), resolve(import.meta.dir, "..")];
  for (const { bytes, path } of entries) {
    if (path.endsWith(".map")) {
      throw new Error(`Packed browser clipper contains source map: ${path}`);
    }
    if (/\.(?:html|js|json|md)$/u.test(path)) {
      const text = new TextDecoder().decode(bytes);
      if (
        text.includes("sourceMappingURL") ||
        forbiddenPaths.some((forbidden) => text.includes(forbidden))
      ) {
        throw new Error(`Packed browser clipper leaks build metadata: ${path}`);
      }
    }
  }
};

export const verifyPackedClipperPackage = async ({
  packageRoot,
  tempRoot,
}: VerifyPackedClipperOptions): Promise<void> => {
  await assertPackageSmokePathContained(tempRoot, packageRoot, "packageRoot");
  const packageManifest = (await Bun.file(
    join(packageRoot, "package.json")
  ).json()) as PackageManifest;
  const distDir = join(packageRoot, "browser-extension", "dist");
  const artifactsDir = join(packageRoot, "browser-extension", "artifacts");
  await assertPackageSmokePathContained(tempRoot, distDir, "clipper dist");
  await assertPackageSmokePathContained(
    tempRoot,
    artifactsDir,
    "clipper artifacts"
  );

  const distEntries = await readDirectoryEntries(distDir);
  const distPaths = distEntries.map(({ path }) => path);
  const generatedChunks = distPaths.filter(
    (path) => !requiredDistFiles.includes(path)
  );
  if (
    !requiredDistFiles.every((path) => distPaths.includes(path)) ||
    generatedChunks.length !== 2 ||
    !generatedChunks.some((path) => /^chunk-[a-z0-9]+\.js$/u.test(path)) ||
    !generatedChunks.some((path) => /^chunk-[a-z0-9]+\.css$/u.test(path))
  ) {
    throw new Error(
      `Packed browser clipper has unexpected unpacked files: ${distPaths.join(", ")}`
    );
  }
  await assertNoBuildLeakage(distDir, distEntries);
  assertExtensionManifest(
    (await Bun.file(
      join(distDir, "manifest.json")
    ).json()) as ExtensionManifest,
    packageManifest.version
  );

  const archiveName = `gno-browser-clipper-v${packageManifest.version}.zip`;
  const artifactEntries = await readDirectoryEntries(artifactsDir);
  if (
    !Bun.deepEquals(
      artifactEntries.map(({ path }) => path),
      [archiveName, `${archiveName}.sha256`],
      true
    )
  ) {
    throw new Error("Packed browser clipper artifacts are incomplete or stale");
  }
  const archive = new Uint8Array(
    await Bun.file(join(artifactsDir, archiveName)).arrayBuffer()
  );
  const checksum = sha256Hex(archive);
  const checksumText = await Bun.file(
    join(artifactsDir, `${archiveName}.sha256`)
  ).text();
  if (checksumText !== `${checksum}  ${archiveName}\n`) {
    throw new Error("Packed browser clipper SHA-256 file is invalid");
  }
  const archiveEntries = readArchiveEntries(archive).map(({ bytes, path }) => ({
    path,
    sha256: sha256Hex(bytes),
  }));
  const unpackedEntries = distEntries.map(({ bytes, path }) => ({
    path,
    sha256: sha256Hex(bytes),
  }));
  if (!Bun.deepEquals(archiveEntries, unpackedEntries, true)) {
    throw new Error(
      "Packed browser clipper archive differs from its unpacked extension"
    );
  }
};

export const runStandaloneClipperPackageSmoke = async (): Promise<void> => {
  const sourceRoot = resolve(import.meta.dir, "..");
  const userStateBefore = await snapshotUserGnoState();
  const tempRoot = await mkdtemp(join(tmpdir(), "gno-clipper-package-smoke-"));
  const packDir = join(tempRoot, "pack");
  const prefix = join(tempRoot, "prefix");
  const home = join(tempRoot, "home");
  const npmCache = join(tempRoot, "npm-cache");
  const npmrc = join(tempRoot, "npmrc");
  const explicitEnv = {
    APPDATA: join(tempRoot, "appdata"),
    CLAUDE_SKILLS_DIR: join(home, ".claude", "skills"),
    CODEX_SKILLS_DIR: join(home, ".codex", "skills"),
    GNO_CACHE_DIR: join(tempRoot, "gno-cache"),
    GNO_CONFIG_DIR: join(tempRoot, "gno-config"),
    GNO_DATA_DIR: join(tempRoot, "gno-data"),
    GNO_NO_AUTO_DOWNLOAD: "1",
    GNO_SKILLS_HOME_OVERRIDE: home,
    HERMES_SKILLS_DIR: join(home, ".hermes", "skills"),
    HOME: home,
    LOCALAPPDATA: join(tempRoot, "local-appdata"),
    NO_COLOR: "1",
    npm_config_cache: npmCache,
    npm_config_prefix: prefix,
    npm_config_userconfig: npmrc,
    OPENCODE_SKILLS_DIR: join(home, ".config", "opencode", "skills"),
    OPENCLAW_SKILLS_DIR: join(home, ".openclaw", "skills"),
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(tempRoot, "xdg-cache"),
    XDG_CONFIG_HOME: join(tempRoot, "xdg-config"),
    XDG_DATA_HOME: join(tempRoot, "xdg-data"),
  };
  const env = await buildPackageSmokeProcessEnv(tempRoot, explicitEnv);
  let smokeError: unknown;
  try {
    await mkdir(packDir, { recursive: true });
    await mkdir(home, { recursive: true });
    await Bun.write(npmrc, "");
    const packed = parseNpmPackOutput(
      runCommand(
        ["npm", "pack", "--json", "--pack-destination", packDir],
        sourceRoot,
        env
      ).stdout
    );
    const tarball = join(packDir, packed.filename);
    runCommand(
      [
        "npm",
        "install",
        "--global",
        "--prefix",
        prefix,
        "--cache",
        npmCache,
        tarball,
      ],
      tempRoot,
      env
    );
    const npmRoot = runCommand(
      ["npm", "root", "--global", "--prefix", prefix],
      tempRoot,
      env
    ).stdout.trim();
    await verifyPackedClipperPackage({
      packageRoot: join(npmRoot, "@gmickel", "gno"),
      tempRoot,
    });
  } catch (error) {
    smokeError = error;
    console.error(`Clipper package smoke recovery directory: ${tempRoot}`);
  }

  let sentinelProof = "";
  try {
    sentinelProof = await verifyUserGnoStateUnchanged(userStateBefore);
  } catch (error) {
    smokeError ??= error;
    console.error(
      `Clipper package smoke forensic recovery directory: ${tempRoot}`
    );
  }
  if (smokeError) {
    throw smokeError;
  }
  if (process.env.GNO_PACKAGE_SMOKE_KEEP_TEMP !== "1") {
    await safeRm(tempRoot);
  }
  console.log(sentinelProof);
  console.log("Browser clipper npm package smoke passed");
};
