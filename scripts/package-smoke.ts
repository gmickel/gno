// node:fs/promises: temp structure and cleanup have no Bun-native equivalent.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os: tmpdir has no Bun-native equivalent.
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { safeRm } from "../test/helpers/cleanup";
import { configurePackedEmbeddingModel } from "./package-smoke-config";
import { verifyPackedMcpInstall } from "./package-smoke-mcp";
import { resolvePackageSmokeEmbeddingModel } from "./package-smoke-model";
import { verifyPackedResidentGateway } from "./package-smoke-resident";
import { verifyPackedFolderSetup } from "./package-smoke-setup";
import {
  snapshotUserGnoState,
  verifyUserGnoStateUnchanged,
} from "./package-smoke-user-sentinel";

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

interface ActivationCollection {
  collection: string;
  ready: boolean;
  semanticAvailability: {
    status: "pending" | "skipped";
    code: string;
  };
}

interface ActivationStatus {
  schemaVersion: "1.0";
  usable: boolean;
  healthy: boolean;
  collections: ActivationCollection[];
  connectors: unknown[];
  connectorProjection: {
    total: number;
    projected: number;
    truncated: boolean;
  };
}

interface DoctorResult {
  healthy: boolean;
  checks: DoctorCheck[];
  activation: ActivationStatus;
}

interface StatusResult {
  healthy: boolean;
  activation: ActivationStatus;
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
    "package/src/core/runtime-entrypoint.ts",
    "package/src/core/folder-setup.ts",
    "package/src/core/setup-activation.ts",
    "package/src/core/setup-receipt.ts",
    "package/src/cli/commands/setup.ts",
    "package/src/cli/commands/setup-activation.ts",
    "package/src/cli/commands/setup-semantic.ts",
    "package/src/cli/setup-semantic-worker.ts",
    "package/src/serve/public/globals.built.css",
    "package/spec/output-schemas/setup-receipt.schema.json",
    "package/spec/output-schemas/setup-command-result.schema.json",
    "package/spec/output-schemas/setup-semantic-receipt.schema.json",
    "package/spec/output-schemas/setup-activation-result.schema.json",
    "package/THIRD_PARTY_NOTICES.md",
  ]) {
    assertTarEntry(entries, requiredFile);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseActivationStatus(
  value: unknown,
  command: "doctor" | "status"
): ActivationStatus {
  if (!isRecord(value)) {
    throw new Error(`gno ${command} --json missing activation object`);
  }

  const projection = value.connectorProjection;
  const collections = value.collections;
  const validProjection =
    isRecord(projection) &&
    Number.isInteger(projection.total) &&
    Number.isInteger(projection.projected) &&
    typeof projection.truncated === "boolean";
  const validCollections =
    Array.isArray(collections) &&
    collections.every(
      (collection) =>
        isRecord(collection) &&
        typeof collection.collection === "string" &&
        typeof collection.ready === "boolean" &&
        isRecord(collection.semanticAvailability) &&
        (collection.semanticAvailability.status === "pending" ||
          collection.semanticAvailability.status === "skipped") &&
        typeof collection.semanticAvailability.code === "string"
    );
  const validShape =
    value.schemaVersion === "1.0" &&
    typeof value.usable === "boolean" &&
    typeof value.healthy === "boolean" &&
    validCollections &&
    Array.isArray(value.connectors) &&
    validProjection;

  if (!validShape) {
    throw new Error(
      `gno ${command} --json activation has unexpected shape:\n${JSON.stringify(value, null, 2)}`
    );
  }
  return value as unknown as ActivationStatus;
}

function parseJsonObject(stdout: string, command: "doctor" | "status") {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed)) {
      throw new Error("top-level value is not an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `gno ${command} --json did not produce valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }\n${stdout}`
    );
  }
}

function parseDoctorJson(stdout: string): DoctorResult {
  const parsed = parseJsonObject(stdout, "doctor");
  const activation = parseActivationStatus(parsed.activation, "doctor");
  const validChecks =
    Array.isArray(parsed.checks) &&
    parsed.checks.every(
      (check) =>
        isRecord(check) &&
        typeof check.name === "string" &&
        (check.status === "ok" ||
          check.status === "warn" ||
          check.status === "error") &&
        typeof check.message === "string"
    );
  if (typeof parsed.healthy !== "boolean" || !validChecks) {
    throw new Error(
      `gno doctor --json has unexpected shape:\n${JSON.stringify(parsed, null, 2)}`
    );
  }
  return { ...parsed, activation } as DoctorResult;
}

function parseStatusJson(stdout: string): StatusResult {
  const parsed = parseJsonObject(stdout, "status");
  const activation = parseActivationStatus(parsed.activation, "status");
  if (typeof parsed.healthy !== "boolean") {
    throw new Error(
      `gno status --json has unexpected shape:\n${JSON.stringify(parsed, null, 2)}`
    );
  }
  return { ...parsed, activation } as StatusResult;
}

function assertLexicalActivationReady(
  activation: ActivationStatus,
  command: "doctor" | "status"
): void {
  const allCollectionsReady =
    activation.collections.length > 0 &&
    activation.collections.every((collection) => collection.ready);
  if (!(activation.usable && activation.healthy && allCollectionsReady)) {
    throw new Error(
      `gno ${command} --json did not prove packaged lexical activation:\n${JSON.stringify(activation, null, 2)}`
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
  const userStateBefore = await snapshotUserGnoState();
  const tempRoot = await mkdtemp(join(tmpdir(), "gno-package-smoke-"));
  let completedTarballPath = "";
  let smokeError: unknown;
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
    await verifyPackedFolderSetup({
      gnoBin,
      packageRoot: join(
        runCommand(
          ["npm", "root", "--global", "--prefix", installPrefix],
          tempRoot,
          env
        ).stdout.trim(),
        "@gmickel",
        "gno"
      ),
      cwd: tempRoot,
      env,
      fixtureDir: notesDir,
      runCommand,
    });
    const embeddingModelPath = await resolvePackageSmokeEmbeddingModel();
    await verifyPackedMcpInstall({
      gnoBin,
      installPrefix,
      cwd: tempRoot,
      env,
      runCommand,
    });
    if (embeddingModelPath) {
      await configurePackedEmbeddingModel(
        join(env.GNO_CONFIG_DIR, "index.yml"),
        embeddingModelPath
      );
    }
    runCommand([gnoBin, "update", "--yes"], tempRoot, env);
    await verifyPackedResidentGateway({
      gnoBin,
      packageRoot: join(
        runCommand(
          ["npm", "root", "--global", "--prefix", installPrefix],
          tempRoot,
          env
        ).stdout.trim(),
        "@gmickel",
        "gno"
      ),
      cwd: tempRoot,
      env,
      fixtureDir: notesDir,
      runCommand,
      embeddingModelPath,
    });

    // Status is a passive report: a successfully generated report exits zero
    // even when its structured health is degraded. This fixture proves the
    // packaged corpus is lexically usable without requiring semantic models.
    const status = parseStatusJson(
      runCommand([gnoBin, "status", "--json"], tempRoot, env).stdout
    );
    assertLexicalActivationReady(status.activation, "status");
    if (
      !status.activation.collections.every(
        ({ semanticAvailability }) => semanticAvailability.status === "pending"
      )
    ) {
      throw new Error(
        `gno status --json unexpectedly claimed semantic readiness:\n${JSON.stringify(status.activation, null, 2)}`
      );
    }

    const doctor = parseDoctorJson(
      runCommand([gnoBin, "doctor", "--json"], tempRoot, env).stdout
    );
    assertLexicalActivationReady(doctor.activation, "doctor");
    assertEmbeddingFingerprintShape(doctor);
    assertNoDoctorErrors(doctor);

    completedTarballPath = tarballPath;
  } catch (error) {
    console.error(`Package smoke temp root: ${tempRoot}`);
    console.error(
      "Set GNO_PACKAGE_SMOKE_KEEP_TEMP=1 to preserve temp dirs on success."
    );
    smokeError = error;
  }

  let sentinelProof: string;
  try {
    sentinelProof = await verifyUserGnoStateUnchanged(userStateBefore);
  } finally {
    if (!preserveTemp) {
      await safeRm(tempRoot);
    }
  }
  if (smokeError) {
    throw smokeError;
  }
  console.log(sentinelProof);
  console.log(`Package smoke passed: ${completedTarballPath}`);
}

await main();
