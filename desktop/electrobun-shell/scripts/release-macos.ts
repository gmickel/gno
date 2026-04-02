// node:fs/promises: release artifact copy/walk/cleanup utilities.
import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
// node:os: temp dir lookup has no Bun equivalent.
import { tmpdir } from "node:os";
// node:path: path manipulation has no Bun equivalent.
import { basename, join, resolve } from "node:path";

import shellConfig from "../electrobun.config";

type CliOptions = {
  appOnly: boolean;
  skipBuild: boolean;
  dryRun: boolean;
  help: boolean;
};

type NotarySubmitResult = {
  id?: string;
  message?: string;
  status?: string;
};

const shellRoot = resolve(import.meta.dir, "..");
const buildDir = join(shellRoot, "build");
const artifactsDir = join(shellRoot, "artifacts");

function parseArgs(argv: string[]): CliOptions {
  const flags = new Set(argv);
  return {
    appOnly: flags.has("--app-only"),
    skipBuild: flags.has("--skip-build"),
    dryRun: flags.has("--dry-run"),
    help: flags.has("--help") || flags.has("-h"),
  };
}

function printHelp(): void {
  console.log(`Usage: bun run release:macos [--app-only] [--skip-build] [--dry-run]

Build and package a signed/notarized macOS desktop beta release.

Required env:
  APPLE_SIGNING_IDENTITY   Developer ID Application identity
  NOTARYTOOL_PROFILE       Keychain profile name for xcrun notarytool

Optional env:
  ELECTROBUN_BUILD_DIR     Override build output dir
  ELECTROBUN_ARTIFACT_DIR  Override artifacts dir

Flags:
  --app-only    Skip DMG creation; produce signed+stapled app zip only
  --skip-build  Reuse an existing desktop build output
  --dry-run     Print planned steps and exit before changing artifacts
`);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    out.push(fullPath);
    if (entry.isDirectory() && !entry.name.endsWith(".app")) {
      out.push(...(await walk(fullPath)));
    }
  }
  return out;
}

async function findFirst(
  root: string,
  predicate: (path: string) => boolean
): Promise<string | null> {
  const paths = await walk(root);
  return paths.find(predicate) ?? null;
}

function expectValue<T>(value: T | null | undefined, label: string): T {
  if (!value) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function runCommand(
  cmd: string[],
  cwd: string,
  env: Record<string, string> = {}
): void {
  const result = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${cmd.join(" ")}): exit ${result.exitCode}`
    );
  }
}

function runCommandCapture(
  cmd: string[],
  cwd: string,
  env: Record<string, string> = {}
): string {
  const result = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stderr: "inherit",
    stdout: "pipe",
  });
  const stdout = result.stdout ? new TextDecoder().decode(result.stdout) : "";
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${cmd.join(" ")}): exit ${result.exitCode}`
    );
  }
  return stdout;
}

async function findBuiltAppBundle(root: string): Promise<string> {
  const appPath = await findFirst(root, (path) => path.endsWith(".app"));
  return expectValue(appPath, "built .app bundle");
}

function isCodeSignableExtension(path: string): boolean {
  return (
    path.endsWith(".dylib") || path.endsWith(".so") || path.endsWith(".node")
  );
}

function isMachOBinary(path: string): boolean {
  const result = Bun.spawnSync(["file", "-b", path], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0 || !result.stdout) {
    return false;
  }
  const output = new TextDecoder().decode(result.stdout);
  return output.includes("Mach-O");
}

async function signNestedBinaries(
  appPath: string,
  signingIdentity: string
): Promise<void> {
  const allPaths = await walk(appPath);
  const targets = allPaths
    .filter((path) => isCodeSignableExtension(path))
    .filter((path) => isMachOBinary(path))
    .sort((left, right) => right.length - left.length);

  for (const target of targets) {
    console.log(`>>> Signing nested binary ${target}`);
    runCommand(
      [
        "codesign",
        "--force",
        "--timestamp",
        "--options",
        "runtime",
        "--sign",
        signingIdentity,
        target,
      ],
      shellRoot
    );
  }
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("release:macos only runs on macOS");
  }

  const options = parseArgs(Bun.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim();
  const notaryProfile = process.env.NOTARYTOOL_PROFILE?.trim();
  const resolvedBuildDir = resolve(
    process.env.ELECTROBUN_BUILD_DIR ?? buildDir
  );
  const resolvedArtifactsDir = resolve(
    process.env.ELECTROBUN_ARTIFACT_DIR ?? artifactsDir
  );
  const resolvedReleaseDir = join(resolvedArtifactsDir, "release-macos");
  const version = shellConfig.app.version;
  const appName = shellConfig.app.name;
  const artifactBase = `${slugify(appName)}-${version}`;

  if (!signingIdentity) {
    throw new Error("APPLE_SIGNING_IDENTITY is required");
  }
  if (!notaryProfile) {
    throw new Error("NOTARYTOOL_PROFILE is required");
  }

  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          appOnly: options.appOnly,
          skipBuild: options.skipBuild,
          buildDir: resolvedBuildDir,
          artifactsDir: resolvedArtifactsDir,
          releaseDir: resolvedReleaseDir,
          appName,
          artifactBase,
          signingIdentity,
          notaryProfile,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`>>> shell root: ${shellRoot}`);
  console.log(`>>> build dir: ${resolvedBuildDir}`);
  console.log(`>>> artifacts dir: ${resolvedArtifactsDir}`);
  console.log(`>>> release dir: ${resolvedReleaseDir}`);

  if (!options.skipBuild) {
    runCommand([process.execPath, "run", "build"], shellRoot);
  }

  runCommand([process.execPath, "run", "verify:packaged-runtime"], shellRoot, {
    ELECTROBUN_BUILD_DIR: resolvedBuildDir,
    ELECTROBUN_ARTIFACT_DIR: resolvedArtifactsDir,
  });

  const buildStat = await stat(resolvedBuildDir).catch(() => null);
  if (!buildStat?.isDirectory()) {
    throw new Error(`Build directory not found: ${resolvedBuildDir}`);
  }

  const builtApp = await findBuiltAppBundle(resolvedBuildDir);
  await mkdir(resolvedReleaseDir, { recursive: true });
  const tempRoot = await mkdtemp(join(tmpdir(), "gno-release-macos-"));
  const workingApp = join(tempRoot, basename(builtApp));

  await cp(builtApp, workingApp, { recursive: true, force: true });

  await signNestedBinaries(workingApp, signingIdentity);

  console.log(`>>> Signing ${workingApp}`);
  runCommand(
    [
      "codesign",
      "--force",
      "--deep",
      "--strict",
      "--timestamp",
      "--options",
      "runtime",
      "--sign",
      signingIdentity,
      workingApp,
    ],
    shellRoot
  );

  console.log(">>> Verifying signature");
  runCommand(
    ["codesign", "--verify", "--deep", "--strict", workingApp],
    shellRoot
  );

  const notaryZip = join(tempRoot, `${artifactBase}-notary.zip`);
  console.log(">>> Creating notarization zip");
  runCommand(
    ["ditto", "-c", "-k", "--keepParent", workingApp, notaryZip],
    shellRoot
  );

  console.log(">>> Submitting for notarization");
  const submitOutput = runCommandCapture(
    [
      "xcrun",
      "notarytool",
      "submit",
      notaryZip,
      "--keychain-profile",
      notaryProfile,
      "--wait",
      "--output-format",
      "json",
    ],
    shellRoot
  );
  const submit = JSON.parse(submitOutput) as NotarySubmitResult;
  if (submit.status !== "Accepted") {
    if (submit.id) {
      const notaryLog = runCommandCapture(
        [
          "xcrun",
          "notarytool",
          "log",
          submit.id,
          "--keychain-profile",
          notaryProfile,
        ],
        shellRoot
      );
      console.error(notaryLog);
    }
    throw new Error(
      `Notarization failed with status ${submit.status ?? "unknown"}`
    );
  }

  console.log(">>> Stapling app");
  runCommand(["xcrun", "stapler", "staple", workingApp], shellRoot);

  console.log(">>> Validating stapled app");
  runCommand(["xcrun", "stapler", "validate", workingApp], shellRoot);
  runCommand(
    ["spctl", "--assess", "--type", "exec", "-vv", workingApp],
    shellRoot
  );

  const finalZip = join(resolvedReleaseDir, `${artifactBase}.zip`);
  await rm(finalZip, { force: true });
  console.log(">>> Creating final stapled zip");
  runCommand(
    ["ditto", "-c", "-k", "--keepParent", workingApp, finalZip],
    shellRoot
  );

  const zipVerifyDir = await mkdtemp(join(tmpdir(), "gno-release-zip-verify-"));
  console.log(">>> Verifying final zip");
  runCommand(["ditto", "-x", "-k", finalZip, zipVerifyDir], shellRoot);
  const extractedApp = join(zipVerifyDir, basename(workingApp));
  runCommand(
    ["codesign", "--verify", "--deep", "--strict", extractedApp],
    shellRoot
  );
  runCommand(["xcrun", "stapler", "validate", extractedApp], shellRoot);
  runCommand(
    ["spctl", "--assess", "--type", "exec", "-vv", extractedApp],
    shellRoot
  );
  await rm(zipVerifyDir, { recursive: true, force: true });

  let finalDmg: string | null = null;
  if (!options.appOnly) {
    const dmgTemp = await mkdtemp(join(tmpdir(), "gno-release-dmg-"));
    const dmgPath = join(tempRoot, `${artifactBase}.dmg`);
    await cp(workingApp, join(dmgTemp, basename(workingApp)), {
      recursive: true,
      force: true,
    });
    runCommand(
      ["ln", "-s", "/Applications", join(dmgTemp, "Applications")],
      shellRoot
    );

    console.log(">>> Creating DMG");
    runCommand(
      [
        "hdiutil",
        "create",
        "-volname",
        appName,
        "-srcfolder",
        dmgTemp,
        "-ov",
        "-format",
        "UDZO",
        dmgPath,
      ],
      shellRoot
    );
    await rm(dmgTemp, { recursive: true, force: true });

    console.log(">>> Notarizing DMG");
    runCommand(
      [
        "xcrun",
        "notarytool",
        "submit",
        dmgPath,
        "--keychain-profile",
        notaryProfile,
        "--wait",
      ],
      shellRoot
    );
    console.log(">>> Stapling DMG");
    runCommand(["xcrun", "stapler", "staple", dmgPath], shellRoot);
    finalDmg = join(resolvedReleaseDir, `${artifactBase}.dmg`);
    await rm(finalDmg, { force: true });
    await cp(dmgPath, finalDmg, { force: true });
  }

  const manifestPath = join(resolvedReleaseDir, `${artifactBase}.json`);
  await Bun.write(
    manifestPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        appName,
        version,
        identifier: shellConfig.app.identifier,
        buildDir: resolvedBuildDir,
        signedApp: workingApp,
        zip: finalZip,
        dmg: finalDmg,
      },
      null,
      2
    )
  );

  console.log(">>> Release artifacts ready");
  console.log(`zip: ${finalZip}`);
  if (finalDmg) {
    console.log(`dmg: ${finalDmg}`);
  }
  console.log(`manifest: ${manifestPath}`);
}

await main();
