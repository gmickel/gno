// node:fs/promises: temp directory structure has no Bun-native equivalent.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os: tmpdir has no Bun-native equivalent.
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { safeRm } from "../test/helpers/cleanup";
import { verifyPackedClipperPackage } from "./package-smoke-clipper";
import { configurePackedEmbeddingModel } from "./package-smoke-config";
import { verifyPackedExportAdapters } from "./package-smoke-exports";
import { buildPackageSmokeProcessEnv } from "./package-smoke-isolation";
import { verifyPackedMcpInstall } from "./package-smoke-mcp";
import { resolvePackageSmokeEmbeddingModel } from "./package-smoke-model";
import { verifyPackedProjectProfile } from "./package-smoke-profile";
import { verifyPackedResidentGateway } from "./package-smoke-resident";
import { verifyPackedFolderSetup } from "./package-smoke-setup";
import {
  formatUserGnoSentinelSafeDetail,
  snapshotUserGnoState,
  verifyUserGnoStateUnchangedDetailed,
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

function sha256(value: ArrayBuffer | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

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
    env,
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

async function verifyTarballContents(
  tarballPath: string,
  env: Record<string, string>
): Promise<void> {
  const packageJson = (await Bun.file(
    join(rootDir, "package.json")
  ).json()) as {
    files?: string[];
    version?: string;
  };
  const entries = runCommand(["tar", "-tzf", tarballPath], rootDir, env)
    .stdout.split("\n")
    .filter(Boolean);

  for (const allowlistedPath of packageJson.files ?? []) {
    assertTarPrefix(entries, `package/${allowlistedPath}`);
  }

  for (const requiredFile of [
    `package/browser-extension/artifacts/gno-browser-clipper-v${packageJson.version}.zip`,
    `package/browser-extension/artifacts/gno-browser-clipper-v${packageJson.version}.zip.sha256`,
    "package/browser-extension/dist/PRIVACY.md",
    "package/browser-extension/dist/content.js",
    "package/browser-extension/dist/manifest.json",
    "package/browser-extension/dist/preview.html",
    "package/browser-extension/dist/service-worker.js",
    "package/package.json",
    "package/bunfig.toml",
    "package/src/index.ts",
    "package/src/sdk/index.ts",
    "package/src/embed/retry.ts",
    "package/src/core/runtime-entrypoint.ts",
    "package/src/core/folder-setup.ts",
    "package/src/core/project-profile.ts",
    "package/src/core/project-profile-apply.ts",
    "package/src/core/project-profile-file.ts",
    "package/src/ingestion/record-container.ts",
    "package/src/ingestion/record-adapter.ts",
    "package/src/store/migrations/022-record-export-lineage.ts",
    "package/src/config/project-profile.ts",
    "package/src/cli/commands/profile.ts",
    "package/src/cli/commands/profile-apply.ts",
    "package/src/core/setup-activation.ts",
    "package/src/core/setup-receipt.ts",
    "package/src/cli/commands/setup.ts",
    "package/src/cli/commands/setup-activation.ts",
    "package/src/cli/commands/setup-profile.ts",
    "package/src/cli/commands/setup-semantic.ts",
    "package/src/cli/setup-semantic-worker.ts",
    "package/src/serve/public/globals.built.css",
    "package/spec/output-schemas/setup-receipt.schema.json",
    "package/spec/output-schemas/setup-command-result.schema.json",
    "package/spec/output-schemas/setup-semantic-receipt.schema.json",
    "package/spec/output-schemas/setup-activation-result.schema.json",
    "package/spec/output-schemas/setup-profile-result.schema.json",
    "package/spec/output-schemas/project-profile-command.schema.json",
    "package/spec/output-schemas/project-profile-apply.schema.json",
    "package/spec/project-profile.schema.json",
    "package/THIRD_PARTY_NOTICES.md",
  ]) {
    assertTarEntry(entries, requiredFile);
  }
  assertTarPrefix(entries, "package/browser-extension/dist/chunk-");
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

/**
 * Launch the *installed* `gno serve` binary (never repo bun source) and verify
 * worker / cmap / standard-font GET bodies match files inside the installed
 * package's pdfjs-dist, with matching HEAD headers and empty HEAD body.
 */
async function verifyInstalledPdfjsAssets(opts: {
  gnoBin: string;
  packageRoot: string;
  cwd: string;
  env: Record<string, string>;
  configDir: string;
  dataDir: string;
  cacheDir: string;
  fixtureDir: string;
}): Promise<void> {
  const port = 45_000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  // Resolve installed pdfjs-dist robustly: package node_modules first, then
  // Bun's resolver from the installed package root (handles hoisting layouts).
  let pdfjsRoot = join(opts.packageRoot, "node_modules", "pdfjs-dist");
  if (!(await Bun.file(join(pdfjsRoot, "package.json")).exists())) {
    try {
      pdfjsRoot = resolve(
        Bun.resolveSync("pdfjs-dist/package.json", opts.packageRoot),
        ".."
      );
    } catch {
      // keep primary path for the explicit missing-file error below
    }
  }
  const assets = [
    {
      urlPath: "/vendor/pdfjs/pdf.worker.raw.min.mjs",
      filePath: join(pdfjsRoot, "build", "pdf.worker.min.mjs"),
    },
    {
      urlPath: "/vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap",
      filePath: join(pdfjsRoot, "cmaps", "UniJIS-UCS2-H.bcmap"),
    },
    {
      urlPath: "/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf",
      filePath: join(pdfjsRoot, "standard_fonts", "LiberationSans-Regular.ttf"),
    },
  ];

  for (const a of assets) {
    const f = Bun.file(a.filePath);
    if (!(await f.exists())) {
      throw new Error(
        `Installed pdfjs-dist missing expected file: ${a.filePath}`
      );
    }
  }

  const server = Bun.spawn(
    [
      opts.gnoBin,
      "--config",
      join(opts.configDir, "index.yml"),
      "serve",
      "--port",
      String(port),
    ],
    {
      cwd: opts.cwd,
      env: {
        ...opts.env,
        GNO_CONFIG_DIR: opts.configDir,
        GNO_DATA_DIR: opts.dataDir,
        GNO_CACHE_DIR: opts.cacheDir,
        GNO_OFFLINE: "1",
        NODE_ENV: "production",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  // Diagnostics only — every assertion below is unchanged. These lines make
  // the durable package-smoke log record the values a reviewer must be able to
  // inspect directly (installed-binary launch, installed-file vs GET-body
  // hashes/sizes, HEAD status/empty body/header equality) instead of only a
  // pass/fail summary.
  console.log("[pdfjs-assets] installed binary:  " + opts.gnoBin);
  console.log("[pdfjs-assets] package root:      " + opts.packageRoot);
  console.log("[pdfjs-assets] installed pdfjs:   " + pdfjsRoot);
  console.log(
    `[pdfjs-assets] launched installed 'gno serve' pid=${server.pid} port=${port} (NOT repo bun source)`
  );

  try {
    for (let i = 0; i < 100; i++) {
      try {
        const h = await fetch(`${baseUrl}/api/health`);
        if (h.ok) {
          break;
        }
      } catch {
        // starting
      }
      await Bun.sleep(100);
      if (i === 99) {
        throw new Error(
          `Installed gno serve did not become healthy on ${baseUrl}`
        );
      }
    }
    console.log(`[pdfjs-assets] installed binary healthy at ${baseUrl}`);

    const bootstrapPath = "/vendor/pdfjs/pdf.worker.min.mjs";
    const bootstrapGet = await fetch(baseUrl + bootstrapPath);
    if (bootstrapGet.status !== 200) {
      throw new Error(
        "GET " +
          bootstrapPath +
          " returned " +
          bootstrapGet.status +
          " from installed gno serve"
      );
    }
    const bootstrapBody = await bootstrapGet.text();
    if (
      !bootstrapBody.includes("Math.sumPrecise") ||
      !bootstrapBody.includes(
        'await import("/vendor/pdfjs/pdf.worker.raw.min.mjs")'
      )
    ) {
      throw new Error(
        "GET " +
          bootstrapPath +
          " did not contain the PDF.js compatibility bootstrap"
      );
    }
    if (/https?:\/\//u.test(bootstrapBody)) {
      throw new Error("GET " + bootstrapPath + " contained an off-origin URL");
    }
    const bootstrapHead = await fetch(baseUrl + bootstrapPath, {
      method: "HEAD",
    });
    const bootstrapHeadBody = await bootstrapHead.arrayBuffer();
    if (bootstrapHead.status !== 200 || bootstrapHeadBody.byteLength !== 0) {
      throw new Error(
        "HEAD " + bootstrapPath + " must return 200 with an empty body"
      );
    }
    for (const header of ["content-type", "content-length", "cache-control"]) {
      if (
        bootstrapGet.headers.get(header) !== bootstrapHead.headers.get(header)
      ) {
        throw new Error(
          "HEAD/GET header mismatch for " + bootstrapPath + " " + header
        );
      }
    }
    console.log(
      "[pdfjs-assets] compatibility bootstrap: GET/HEAD 200, Math.sumPrecise + same-origin raw worker import verified"
    );

    for (const a of assets) {
      const expected = await Bun.file(a.filePath).bytes();
      const expectedHash = sha256(expected);
      console.log(`[pdfjs-assets] --- ${a.urlPath} ---`);
      console.log(`[pdfjs-assets]   installed file: ${a.filePath}`);
      console.log(
        `[pdfjs-assets]   installed bytes=${expected.byteLength} sha256=${expectedHash}`
      );

      const getRes = await fetch(`${baseUrl}${a.urlPath}`);
      if (getRes.status !== 200) {
        throw new Error(
          `GET ${a.urlPath} → ${getRes.status} (installed gno serve)`
        );
      }
      const body = new Uint8Array(await getRes.arrayBuffer());
      const bodyHash = sha256(body);
      console.log(
        `[pdfjs-assets]   GET status=${getRes.status} bytes=${body.byteLength} sha256=${bodyHash}`
      );
      console.log(
        `[pdfjs-assets]   byte-equality: ${bodyHash === expectedHash ? "MATCH" : "MISMATCH"} (size ${expected.byteLength === body.byteLength ? "equal" : "differs"})`
      );
      if (bodyHash !== expectedHash) {
        throw new Error(
          `GET ${a.urlPath} body hash mismatch vs installed pdfjs-dist file ${a.filePath}\n expected ${expectedHash}\n got      ${bodyHash}`
        );
      }

      const headRes = await fetch(`${baseUrl}${a.urlPath}`, {
        method: "HEAD",
      });
      if (headRes.status !== 200) {
        throw new Error(
          `HEAD ${a.urlPath} → ${headRes.status} (installed gno serve)`
        );
      }
      const headBody = await headRes.arrayBuffer();
      console.log(
        `[pdfjs-assets]   HEAD status=${headRes.status} bodyBytes=${headBody.byteLength} (expected 0)`
      );
      if (headBody.byteLength !== 0) {
        throw new Error(
          `HEAD ${a.urlPath} returned non-empty body (${headBody.byteLength} bytes)`
        );
      }
      for (const h of ["content-type", "content-length", "cache-control"]) {
        const gv = getRes.headers.get(h);
        const hv = headRes.headers.get(h);
        console.log(
          `[pdfjs-assets]   header ${h}: GET=${gv} HEAD=${hv} ${gv === hv ? "MATCH" : "MISMATCH"}`
        );
        if (gv !== hv) {
          throw new Error(
            `HEAD/GET header mismatch for ${a.urlPath} ${h}: GET=${gv} HEAD=${hv}`
          );
        }
      }
    }
    console.log(
      "Installed binary pdfjs asset smoke passed (worker + cmap + standard-font GET/HEAD)"
    );
  } finally {
    server.kill();
    await server.exited.catch(() => undefined);
  }
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
  const explicitEnv = {
    APPDATA: join(tempRoot, "appdata"),
    CLAUDE_SKILLS_DIR: join(homeDir, ".claude", "skills"),
    CODEX_SKILLS_DIR: join(homeDir, ".codex", "skills"),
    GNO_CACHE_DIR: join(tempRoot, "gno-cache"),
    GNO_CONFIG_DIR: join(tempRoot, "gno-config"),
    GNO_DATA_DIR: join(tempRoot, "gno-data"),
    GNO_NO_AUTO_DOWNLOAD: "1",
    GNO_SKILLS_HOME_OVERRIDE: homeDir,
    HERMES_SKILLS_DIR: join(homeDir, ".hermes", "skills"),
    HOME: homeDir,
    LOCALAPPDATA: join(tempRoot, "local-appdata"),
    NO_COLOR: "1",
    npm_config_cache: npmCacheDir,
    npm_config_prefix: installPrefix,
    npm_config_userconfig: npmUserConfig,
    OPENCODE_SKILLS_DIR: join(homeDir, ".config", "opencode", "skills"),
    OPENCLAW_SKILLS_DIR: join(homeDir, ".openclaw", "skills"),
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
    USERPROFILE: homeDir,
    XDG_CACHE_HOME: join(tempRoot, "xdg-cache"),
    XDG_CONFIG_HOME: join(tempRoot, "xdg-config"),
    XDG_DATA_HOME: join(tempRoot, "xdg-data"),
  };
  const env = await buildPackageSmokeProcessEnv(tempRoot, explicitEnv);

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
    await verifyTarballContents(tarballPath, env);

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
    const packageRoot = join(
      runCommand(
        ["npm", "root", "--global", "--prefix", installPrefix],
        tempRoot,
        env
      ).stdout.trim(),
      "@gmickel",
      "gno"
    );
    runCommand([gnoBin, "--version"], tempRoot, env);
    runCommand([gnoBin, "--help"], tempRoot, env);
    await verifyPackedClipperPackage({ packageRoot, tempRoot });
    await verifyPackedFolderSetup({
      gnoBin,
      packageRoot,
      cwd: tempRoot,
      env,
      fixtureDir: notesDir,
      runCommand,
    });
    await verifyPackedProjectProfile({
      gnoBin,
      cwd: tempRoot,
      env,
      runCommand,
    });
    await verifyPackedExportAdapters({
      gnoBin,
      cwd: tempRoot,
      env,
      configDir: explicitEnv.GNO_CONFIG_DIR,
      tempRoot,
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

    // Prove the installed PDF.js assets before configuring the real embedding
    // model. This check is model-independent; running it afterward makes a
    // fresh server wait for model initialization and can exceed the bounded
    // health probe on slower CI hosts.
    await verifyInstalledPdfjsAssets({
      gnoBin,
      packageRoot,
      cwd: tempRoot,
      env,
      configDir: explicitEnv.GNO_CONFIG_DIR,
      dataDir: explicitEnv.GNO_DATA_DIR,
      cacheDir: explicitEnv.GNO_CACHE_DIR,
      fixtureDir: notesDir,
    });

    if (embeddingModelPath) {
      await configurePackedEmbeddingModel(
        join(explicitEnv.GNO_CONFIG_DIR, "index.yml"),
        embeddingModelPath
      );
    }
    runCommand([gnoBin, "update", "--yes"], tempRoot, env);
    if (embeddingModelPath) {
      // A resident embeds any backlog it starts with. Clear it first so the
      // warm-reuse lease counts measure only the smoke's own calls.
      runCommand([gnoBin, "embed", "--batch-size", "8"], tempRoot, env);
    }
    await verifyPackedResidentGateway({
      gnoBin,
      packageRoot,
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
    console.error("Failure preserved this forensic recovery directory.");
    smokeError = error;
  }

  let sentinelProof = "";
  try {
    const detailed = await verifyUserGnoStateUnchangedDetailed(userStateBefore);
    sentinelProof = detailed.proof;
    // Diagnostics only — the assertion above already decided pass/fail over the
    // COMPLETE snapshots (hashes included). What is printed here is deliberately
    // narrowed so the durable artifact carries no credential-derived metadata.
    console.log(
      formatUserGnoSentinelSafeDetail(userStateBefore, detailed.after)
    );
  } catch (error) {
    smokeError ??= error;
    console.error(`Package smoke forensic recovery directory: ${tempRoot}`);
  } finally {
    if (!(preserveTemp || smokeError)) {
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
