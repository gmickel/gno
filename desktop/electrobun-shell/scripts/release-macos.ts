// node:fs/promises: release artifact copy/walk/cleanup utilities.
import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
// node:os: temp dir lookup has no Bun equivalent.
import { tmpdir } from "node:os";
// node:path: path manipulation has no Bun equivalent.
import { basename, join, posix, resolve } from "node:path";

import shellConfig from "../electrobun.config";

/**
 * Runtime entitlements required by the packaged Bun executable. JavaScriptCore
 * needs JIT permission under the hardened runtime. Electrobun's Worker startup
 * also executes generated Bun/JSC pages that macOS 27 otherwise kills as an
 * invalid code-signing page. GNO deliberately loads the user's Homebrew SQLite
 * so native extensions work on macOS; that dylib has Homebrew's Team ID, so
 * library validation must be disabled on this executable. Keep all three
 * entitlements scoped to Contents/MacOS/bun.
 */
const JIT_ENTITLEMENT_KEY = "com.apple.security.cs.allow-jit";
const UNSIGNED_EXECUTABLE_MEMORY_ENTITLEMENT_KEY =
  "com.apple.security.cs.allow-unsigned-executable-memory";
const LIBRARY_VALIDATION_ENTITLEMENT_KEY =
  "com.apple.security.cs.disable-library-validation";

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
const entitlementsPath = join(shellRoot, "macos", "gno-desktop.entitlements");

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

/**
 * Capture both streams without throwing. `codesign -d` writes its
 * `Executable=` line and its CodeDirectory dump to stderr, and exits non-zero
 * on an unsigned target - the readback assertions need all of that verbatim.
 */
function runCommandCaptureBoth(
  cmd: string[],
  cwd: string
): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const decoder = new TextDecoder();
  return {
    stdout: result.stdout ? decoder.decode(result.stdout) : "",
    stderr: result.stderr ? decoder.decode(result.stderr) : "",
    exitCode: result.exitCode ?? -1,
  };
}

/**
 * Remove XML constructs that are not element content: comments, CDATA
 * sections, processing instructions and the doctype. Without this the tag scan
 * below treats a commented-out entitlement as a live one, which is a false
 * green on the release gate.
 *
 * Returns null when a construct is opened but never closed - a truncated
 * readback must fail the gate, never silently drop the rest of the document.
 */
function stripXmlNonContent(xml: string): string | null {
  const openers: Array<{ open: string; close: string }> = [
    { open: "<!--", close: "-->" },
    { open: "<![CDATA[", close: "]]>" },
    { open: "<?", close: "?>" },
    { open: "<!DOCTYPE", close: ">" },
  ];

  let out = "";
  let index = 0;

  outer: while (index < xml.length) {
    if (xml[index] === "<") {
      for (const { open, close } of openers) {
        if (xml.startsWith(open, index)) {
          const end = xml.indexOf(close, index + open.length);
          if (end < 0) {
            return null;
          }
          index = end + close.length;
          continue outer;
        }
      }
    }
    out += xml[index];
    index += 1;
  }

  return out;
}

/**
 * `runCommandCaptureBoth` that throws on a nonzero exit. A readback that failed
 * to run is not evidence of anything, and must never be silently treated as a
 * passing gate.
 */
function runCommandCaptureBothChecked(
  cmd: string[],
  cwd: string
): { stdout: string; stderr: string; exitCode: number } {
  const result = runCommandCaptureBoth(cmd, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${cmd.join(" ")}): exit ${result.exitCode}. stderr: ${JSON.stringify(result.stderr)}`
    );
  }
  return result;
}

/**
 * Read a boolean entitlement out of `codesign -d --entitlements - --xml`
 * stdout. Returns `null` when the output is not a plist (including the empty
 * string, which is what codesign emits - with exit code 0 - for a binary that
 * carries no entitlements at all) or when the key is absent.
 *
 * Never throws: malformed output is a gate failure, not a crash.
 */
export function readEntitlementBoolean(
  entitlementsXml: string,
  key: string
): boolean | null {
  const content = stripXmlNonContent(entitlementsXml);
  if (content === null) {
    return null;
  }
  const rootDict = extractRootDictBody(content);
  if (rootDict === null) {
    return null;
  }
  return readDirectChildBoolean(rootDict, key);
}

/**
 * Return the contents of the plist's ROOT `<dict>`, or null if the document is
 * not a complete, well-formed plist wrapping exactly one dict.
 *
 * Rejects, in order: a missing or unclosed `<plist>` envelope, trailing content
 * after `</plist>`, a root element that is not a single `<dict>`, and an
 * unbalanced dict nesting. Truncated readback fails here, which is the point:
 * `codesign` can return a short read, and a substring match on the entitlement
 * key would otherwise report a false green.
 *
 * Deliberately pure - no plutil subprocess - so the release gate's parsing stays
 * unit-testable without a signed binary.
 */
function extractRootDictBody(xml: string): string | null {
  const plistOpen = xml.indexOf("<plist");
  if (plistOpen < 0) {
    return null;
  }
  const plistHeadEnd = xml.indexOf(">", plistOpen);
  if (plistHeadEnd < 0) {
    return null;
  }
  const plistClose = xml.indexOf("</plist>", plistHeadEnd);
  if (plistClose < 0) {
    return null;
  }
  if (xml.slice(plistClose + "</plist>".length).trim().length > 0) {
    return null;
  }

  const body = xml.slice(plistHeadEnd + 1, plistClose).trim();
  if (!(body.startsWith("<dict>") && body.endsWith("</dict>"))) {
    return null;
  }

  // Walk dict tags so the trailing `</dict>` is proven to close the ROOT dict
  // rather than a nested one.
  const dictTag = /<(\/?)dict\s*>/g;
  let depth = 0;
  let match = dictTag.exec(body);
  while (match !== null) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0 && dictTag.lastIndex !== body.length) {
      return null;
    }
    if (depth < 0) {
      return null;
    }
    match = dictTag.exec(body);
  }
  if (depth !== 0) {
    return null;
  }

  return body.slice("<dict>".length, body.length - "</dict>".length);
}

/**
 * Read a boolean whose `<key>` is a DIRECT child of the given dict body.
 *
 * Depth tracking matters: `<dict></dict><key>k</key><true/>` and a key buried in
 * a nested dict or array must not satisfy a lookup for a top-level entitlement.
 * Anything unrecognized returns null so the caller fails closed.
 */
function readDirectChildBoolean(dictBody: string, key: string): boolean | null {
  const tag = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g;
  let depth = 0;
  let pendingKey: string | null = null;
  let match = tag.exec(dictBody);

  while (match !== null) {
    const isClosing = match[1] === "/";
    const name = match[2];
    const isSelfClosing = match[4] === "/";

    if (name === "key" && !(isClosing || isSelfClosing)) {
      const textEnd = dictBody.indexOf("</key>", tag.lastIndex);
      if (textEnd < 0) {
        return null;
      }
      if (depth === 0) {
        pendingKey = dictBody.slice(tag.lastIndex, textEnd).trim();
      }
      tag.lastIndex = textEnd + "</key>".length;
      match = tag.exec(dictBody);
      continue;
    }

    if (isClosing) {
      if (name === "dict" || name === "array") {
        depth -= 1;
        if (depth < 0) {
          return null;
        }
      }
    } else if (isSelfClosing) {
      if (depth === 0) {
        if (pendingKey === key && (name === "true" || name === "false")) {
          return name === "true";
        }
        pendingKey = null;
      }
    } else if (name === "dict" || name === "array") {
      depth += 1;
      if (depth === 1) {
        pendingKey = null;
      }
    } else if (depth === 0) {
      pendingKey = null;
    }

    match = tag.exec(dictBody);
  }

  return null;
}

/**
 * True only when the JIT entitlement is present AND set to `<true/>`. A
 * present-but-`<false/>` key is a well-formed plist with JIT still disabled, so
 * key-presence or substring checks are not enough.
 */
export function hasJitEntitlement(entitlementsXml: string): boolean {
  return readEntitlementBoolean(entitlementsXml, JIT_ENTITLEMENT_KEY) === true;
}

/** True only when Bun/JSC generated executable pages are explicitly enabled. */
export function hasUnsignedExecutableMemoryEntitlement(
  entitlementsXml: string
): boolean {
  return (
    readEntitlementBoolean(
      entitlementsXml,
      UNSIGNED_EXECUTABLE_MEMORY_ENTITLEMENT_KEY
    ) === true
  );
}

/** True only when cross-Team-ID library loading is explicitly enabled. */
export function hasDisabledLibraryValidation(entitlementsXml: string): boolean {
  return (
    readEntitlementBoolean(
      entitlementsXml,
      LIBRARY_VALIDATION_ENTITLEMENT_KEY
    ) === true
  );
}

/**
 * Detect the hardened-runtime CodeDirectory flag in `codesign -dvvv` output,
 * which reports e.g. `flags=0x10000(runtime)` on stderr. `codesign --verify`
 * does not prove `--options runtime` survived, so this is read separately.
 */
export function hasHardenedRuntimeFlag(codesignOutput: string): boolean {
  const match = /flags=0x[0-9a-f]+\(([^)]*)\)/i.exec(codesignOutput);
  if (!match?.[1]) {
    return false;
  }
  return match[1].split(",").some((flag) => flag.trim() === "runtime");
}

/**
 * Release gate. Runs after the bundle seal and before notarization is
 * submitted, so a build that lost the entitlement costs a build rather than a
 * release. The target is resolved by explicit relative path: a second, already
 * entitled `bun` is vendored under Contents/Resources, and any name-based
 * lookup would read that one and report a false green.
 */
export function assertBundledBunHardening(appPath: string): void {
  const bunPath = bundledBunPath(appPath);
  console.log(`>>> Asserting required runtime entitlements on ${bunPath}`);

  const entitlements = runCommandCaptureBoth(
    ["codesign", "-d", "--entitlements", "-", "--xml", bunPath],
    shellRoot
  );
  if (entitlements.exitCode !== 0) {
    throw new Error(
      `Entitlement gate failed for ${bunPath}: codesign -d --entitlements exited ${entitlements.exitCode}. ` +
        `A failed readback is never a pass. stderr: ${JSON.stringify(entitlements.stderr)}`
    );
  }
  if (!hasJitEntitlement(entitlements.stdout)) {
    throw new Error(
      `Entitlement gate failed for ${bunPath}: expected ${JIT_ENTITLEMENT_KEY} set to <true/>. ` +
        `codesign -d --entitlements - --xml exited ${entitlements.exitCode} with stdout: ${JSON.stringify(entitlements.stdout)}`
    );
  }
  if (!hasUnsignedExecutableMemoryEntitlement(entitlements.stdout)) {
    throw new Error(
      `Entitlement gate failed for ${bunPath}: expected ${UNSIGNED_EXECUTABLE_MEMORY_ENTITLEMENT_KEY} set to <true/>. ` +
        `codesign -d --entitlements - --xml exited ${entitlements.exitCode} with stdout: ${JSON.stringify(entitlements.stdout)}`
    );
  }
  if (!hasDisabledLibraryValidation(entitlements.stdout)) {
    throw new Error(
      `Entitlement gate failed for ${bunPath}: expected ${LIBRARY_VALIDATION_ENTITLEMENT_KEY} set to <true/>. ` +
        `codesign -d --entitlements - --xml exited ${entitlements.exitCode} with stdout: ${JSON.stringify(entitlements.stdout)}`
    );
  }

  const display = runCommandCaptureBothChecked(
    ["codesign", "-dvvv", bunPath],
    shellRoot
  );
  if (!hasHardenedRuntimeFlag(`${display.stderr}${display.stdout}`)) {
    throw new Error(
      `Hardened runtime gate failed for ${bunPath}: expected flags=0x10000(runtime). ` +
        `codesign -dvvv exited ${display.exitCode} with stderr: ${JSON.stringify(display.stderr)}`
    );
  }

  console.log(
    `>>> ${bunPath}: required runtime entitlements present, hardened runtime set`
  );
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

/**
 * Limit expensive `file` probes to paths that the signing policy can act on.
 * Bundle paths use macOS/POSIX semantics even when classifiers run on another host.
 * A packaged runtime contains tens of thousands of assets; probing every one
 * serially adds minutes without changing which binaries are signed.
 */
export function isPotentialSigningPath(
  appPath: string,
  candidatePath: string
): boolean {
  return (
    isCodeSignableExtension(candidatePath) ||
    posix.dirname(candidatePath) === posix.join(appPath, "Contents", "MacOS")
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

/** A discovered bundle entry plus the result of the impure Mach-O probe. */
export type SigningCandidate = {
  path: string;
  isMachO: boolean;
};

export type NestedSigningTargets = {
  /** `.dylib` / `.so` / `.node` code. Signed without entitlements. */
  extensionMatched: string[];
  /** Extensionless Mach-O executables directly under `Contents/MacOS`. */
  machOExecutables: string[];
  /** Mach-O code deliberately left with its existing signature. */
  skipped: string[];
};

/** The bundled runtime the launcher actually execs. Never resolved by name. */
export function bundledBunPath(appPath: string): string {
  return posix.join(appPath, "Contents", "MacOS", "bun");
}

/**
 * Pure target classification. Takes candidates produced by the impure
 * discovery pass and splits them into the two signing passes.
 *
 * Anything Mach-O supplied to this classifier that is neither
 * extension-matched nor a `Contents/MacOS` executable lands in `skipped`. The
 * inventory tests include the vendored `Contents/Resources/app/gno-runtime/node_modules/
 * @oven/bun-darwin-aarch64/bin/bun`. Skipping it is deliberate, not an
 * oversight - it already carries a valid upstream Bun Developer ID signature
 * with its own entitlements, and it is never executed at runtime (the launcher
 * execs `./bun`, i.e. `Contents/MacOS/bun`). Re-signing it would replace a good
 * signature with ours for no benefit.
 */
export function classifyNestedSigningTargets(
  appPath: string,
  candidates: SigningCandidate[]
): NestedSigningTargets {
  const macOsDir = posix.join(appPath, "Contents", "MacOS");
  const targets: NestedSigningTargets = {
    extensionMatched: [],
    machOExecutables: [],
    skipped: [],
  };

  for (const candidate of candidates) {
    if (!candidate.isMachO) {
      continue;
    }
    if (isCodeSignableExtension(candidate.path)) {
      targets.extensionMatched.push(candidate.path);
    } else if (posix.dirname(candidate.path) === macOsDir) {
      targets.machOExecutables.push(candidate.path);
    } else {
      targets.skipped.push(candidate.path);
    }
  }

  // Deepest paths first: nested code must be signed before its container.
  const deepestFirst = (left: string, right: string): number =>
    right.length - left.length;
  targets.extensionMatched.sort(deepestFirst);
  targets.machOExecutables.sort(deepestFirst);
  targets.skipped.sort(deepestFirst);

  return targets;
}

/**
 * Pure argv builder for a nested-code signature. `entitlements` is passed only
 * for the Bun binary that needs JIT executable memory and cross-Team-ID
 * Homebrew SQLite loading; entitlements are meaningless on dylibs and on the
 * helper executables.
 */
export function buildNestedSignArgv(
  target: string,
  signingIdentity: string,
  entitlements: string | null = null
): string[] {
  return [
    "codesign",
    "--force",
    "--timestamp",
    "--options",
    "runtime",
    ...(entitlements ? ["--entitlements", entitlements] : []),
    "--sign",
    signingIdentity,
    target,
  ];
}

/**
 * Pure argv builder for the final bundle seal.
 *
 * `--deep` is deliberately absent: it re-signs nested code with the bundle's
 * entitlement set, which strips the runtime entitlements applied above. Verified
 * empirically, and it matches Apple DTS guidance that `--deep` is a mistake for
 * anything but a quick local experiment.
 */
export function buildBundleSignArgv(
  appPath: string,
  signingIdentity: string
): string[] {
  return [
    "codesign",
    "--force",
    "--strict",
    "--timestamp",
    "--options",
    "runtime",
    "--sign",
    signingIdentity,
    appPath,
  ];
}

/** Impure discovery: walks the bundle and probes each entry for Mach-O. */
async function discoverSigningCandidates(
  appPath: string
): Promise<SigningCandidate[]> {
  const allPaths = await walk(appPath);
  return allPaths
    .filter((candidatePath) => isPotentialSigningPath(appPath, candidatePath))
    .map((path) => ({ path, isMachO: isMachOBinary(path) }));
}

export async function signNestedBinaries(
  appPath: string,
  signingIdentity: string
): Promise<void> {
  const candidates = await discoverSigningCandidates(appPath);
  const targets = classifyNestedSigningTargets(appPath, candidates);
  const bunPath = bundledBunPath(appPath);

  for (const target of targets.extensionMatched) {
    console.log(`>>> Signing nested binary ${target}`);
    runCommand(buildNestedSignArgv(target, signingIdentity), shellRoot);
  }

  for (const target of targets.machOExecutables) {
    const entitlements = target === bunPath ? entitlementsPath : null;
    console.log(
      `>>> Signing nested executable ${target}${
        entitlements ? " (with runtime entitlements)" : ""
      }`
    );
    runCommand(
      buildNestedSignArgv(target, signingIdentity, entitlements),
      shellRoot
    );
  }

  for (const target of targets.skipped) {
    console.log(`>>> Preserving existing signature on ${target}`);
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
  runCommand(buildBundleSignArgv(workingApp, signingIdentity), shellRoot);

  console.log(">>> Verifying signature");
  runCommand(
    ["codesign", "--verify", "--deep", "--strict", workingApp],
    shellRoot
  );
  assertBundledBunHardening(workingApp);

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
  assertBundledBunHardening(extractedApp);
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

if (import.meta.main) {
  await main();
}
