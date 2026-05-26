// node:fs/promises: temp dir structure and cleanup have no Bun-native equivalent.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os: tmpdir has no Bun-native equivalent.
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { safeRm } from "../test/helpers/cleanup";

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
  embeddingFingerprint?: {
    currentFingerprint: string;
    pendingChunks: number;
    legacyChunks: number;
    mixedGroups: number;
    groups: unknown[];
  };
}

interface DoctorResult {
  healthy: boolean;
  checks: DoctorCheck[];
}

interface NpmPackResult {
  filename: string;
}

const rootDir = resolve(import.meta.dir, "..");
const preserveTemp = process.env.GNO_PACKAGE_SMOKE_KEEP_TEMP === "1";

function formatCommand(cmd: string[]): string {
  return cmd
    .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
    .join(" ");
}

function runCommand(
  cmd: string[],
  cwd: string,
  env: Record<string, string>
): CommandResult {
  const result = Bun.spawnSync(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });

  const stdout = result.stdout ? new TextDecoder().decode(result.stdout) : "";
  const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : "";
  if (result.exitCode !== 0) {
    throw new Error(
      [
        `Command failed: ${formatCommand(cmd)}`,
        `Exit: ${result.exitCode}`,
        "Stdout:",
        stdout || "(empty)",
        "Stderr:",
        stderr || "(empty)",
      ].join("\n")
    );
  }
  return { stdout, stderr };
}

function parseNpmPackOutput(stdout: string): NpmPackResult {
  const jsonStart = stdout.indexOf("[");
  const jsonEnd = stdout.lastIndexOf("]");
  const jsonPayload =
    jsonStart >= 0 && jsonEnd > jsonStart
      ? stdout.slice(jsonStart, jsonEnd + 1)
      : stdout;
  try {
    const results = JSON.parse(jsonPayload) as NpmPackResult[];
    const first = results[0];
    if (first?.filename) {
      return first;
    }
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error(`Unable to parse npm pack JSON output:\n${stdout}`);
}

function assertTarEntry(entries: string[], path: string): void {
  if (!entries.includes(path)) {
    throw new Error(`Packed tarball missing required file: ${path}`);
  }
}

function assertTarPrefix(entries: string[], path: string): void {
  if (!entries.some((entry) => entry.startsWith(path))) {
    throw new Error(`Packed tarball missing required package path: ${path}`);
  }
}

async function verifyTarballContents(tarballPath: string): Promise<void> {
  const packageJson = (await Bun.file(
    join(rootDir, "package.json")
  ).json()) as {
    files?: string[];
  };
  const entries = runCommand(["tar", "-tzf", tarballPath], rootDir, {})
    .stdout.split("\n")
    .filter(Boolean);

  for (const allowlistedPath of packageJson.files ?? []) {
    assertTarPrefix(entries, `package/${allowlistedPath}`);
  }

  for (const requiredFile of [
    "package/package.json",
    "package/bunfig.toml",
    "package/src/index.ts",
    "package/src/sdk/index.ts",
    "package/src/embed/retry.ts",
    "package/src/serve/public/globals.built.css",
    "package/THIRD_PARTY_NOTICES.md",
  ]) {
    assertTarEntry(entries, requiredFile);
  }
}

function parseDoctorJson(stdout: string): DoctorResult {
  try {
    return JSON.parse(stdout) as DoctorResult;
  } catch (error) {
    throw new Error(
      `gno doctor --json did not produce valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }\n${stdout}`
    );
  }
}

function assertEmbeddingFingerprintShape(result: DoctorResult): void {
  const check = result.checks.find(
    (candidate) => candidate.name === "embedding-fingerprint"
  );
  if (!check) {
    throw new Error("doctor output missing embedding-fingerprint check");
  }
  const payload = check.embeddingFingerprint;
  if (!payload) {
    throw new Error("embedding-fingerprint check missing embeddingFingerprint");
  }

  const validShape =
    typeof payload.currentFingerprint === "string" &&
    Number.isInteger(payload.pendingChunks) &&
    Number.isInteger(payload.legacyChunks) &&
    Number.isInteger(payload.mixedGroups) &&
    Array.isArray(payload.groups);
  if (!validShape) {
    throw new Error(
      `embeddingFingerprint has unexpected shape:\n${JSON.stringify(payload, null, 2)}`
    );
  }
}

function assertNoDoctorErrors(result: DoctorResult): void {
  const errors = result.checks.filter((check) => check.status === "error");
  if (errors.length > 0) {
    throw new Error(
      `gno doctor --json reported error checks:\n${JSON.stringify(errors, null, 2)}`
    );
  }
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "gno-package-smoke-"));
  const packDir = join(tempRoot, "pack");
  const installPrefix = join(tempRoot, "prefix");
  const npmCacheDir = join(tempRoot, "npm-cache");
  const npmUserConfig = join(tempRoot, "npmrc");
  const homeDir = join(tempRoot, "home");
  const notesDir = join(tempRoot, "notes");
  const env = {
    GNO_CACHE_DIR: join(tempRoot, "gno-cache"),
    GNO_CONFIG_DIR: join(tempRoot, "gno-config"),
    GNO_DATA_DIR: join(tempRoot, "gno-data"),
    GNO_NO_AUTO_DOWNLOAD: "1",
    HOME: homeDir,
    npm_config_cache: npmCacheDir,
    npm_config_prefix: installPrefix,
    npm_config_userconfig: npmUserConfig,
    XDG_CACHE_HOME: join(tempRoot, "xdg-cache"),
    XDG_CONFIG_HOME: join(tempRoot, "xdg-config"),
    XDG_DATA_HOME: join(tempRoot, "xdg-data"),
  };

  try {
    await mkdir(packDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await mkdir(notesDir, { recursive: true });
    await Bun.write(npmUserConfig, "");
    await Bun.write(join(notesDir, "hello.md"), "# Hello\n\nPackage smoke.\n");

    const pack = runCommand(
      ["npm", "pack", "--json", "--pack-destination", packDir],
      rootDir,
      env
    );
    const packed = parseNpmPackOutput(pack.stdout);
    const tarballPath = join(packDir, packed.filename);
    await verifyTarballContents(tarballPath);

    runCommand(
      [
        "npm",
        "install",
        "--global",
        "--prefix",
        installPrefix,
        "--cache",
        npmCacheDir,
        tarballPath,
      ],
      tempRoot,
      env
    );

    const gnoBin = join(installPrefix, "bin", "gno");
    runCommand([gnoBin, "--version"], tempRoot, env);
    runCommand([gnoBin, "--help"], tempRoot, env);
    runCommand(
      [gnoBin, "init", notesDir, "--name", "package-smoke"],
      tempRoot,
      env
    );

    const doctor = parseDoctorJson(
      runCommand([gnoBin, "doctor", "--json"], tempRoot, env).stdout
    );
    assertEmbeddingFingerprintShape(doctor);
    assertNoDoctorErrors(doctor);

    console.log(`Package smoke passed: ${tarballPath}`);
  } catch (error) {
    console.error(`Package smoke temp root: ${tempRoot}`);
    console.error(
      "Set GNO_PACKAGE_SMOKE_KEEP_TEMP=1 to preserve temp dirs on success."
    );
    throw error;
  } finally {
    if (!preserveTemp) {
      await safeRm(tempRoot);
    }
  }
}

await main();
