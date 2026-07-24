/** Isolated installed-connector path validation and byte snapshot. */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertPackageSmokeEnvironment,
  assertPackageSmokePathContained,
  packageSmokeConnectorPaths,
} from "./package-smoke-isolation";

export type ConnectorByteSnapshot = Record<string, string>;

export interface ConnectorSnapshotOptions {
  tempRoot: string;
  packageRoot: string;
  cwd: string;
  homeDir: string;
  env: Record<string, string>;
}

const moduleUrl = (packageRoot: string, relativePath: string): string =>
  pathToFileURL(join(packageRoot, relativePath)).href;

async function fileSha256(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");
}

async function readInstalledConnectorBytes(
  options: ConnectorSnapshotOptions
): Promise<ConnectorByteSnapshot> {
  await assertPackageSmokeEnvironment(options.tempRoot, process.env);
  for (const [label, path] of [
    ["packageRoot", options.packageRoot],
    ["connector cwd", options.cwd],
    ["connector home", options.homeDir],
  ] as const) {
    await assertPackageSmokePathContained(options.tempRoot, path, label);
  }
  for (const [id, path] of Object.entries(
    packageSmokeConnectorPaths(process.env)
  )) {
    await assertPackageSmokePathContained(
      options.tempRoot,
      path,
      `${id} expected connector path`
    );
  }

  const connectors = (await import(
    moduleUrl(options.packageRoot, "src/serve/connectors.ts")
  )) as typeof import("../src/serve/connectors");
  const statuses = await connectors.getConnectorStatuses({
    cwd: options.cwd,
    homeDir: options.homeDir,
  });
  for (const status of statuses) {
    await assertPackageSmokePathContained(
      options.tempRoot,
      status.path,
      `${status.id} resolved connector path`
    );
  }

  const snapshot: ConnectorByteSnapshot = {};
  for (const status of statuses) {
    if (!status.installed) {
      continue;
    }
    if (status.installKind === "mcp") {
      snapshot[`${status.id}/config`] = await fileSha256(status.path);
      continue;
    }
    const glob = new Bun.Glob("**/*");
    const relativePaths = [
      ...(await Array.fromAsync(
        glob.scan({ cwd: status.path, onlyFiles: true })
      )),
    ].sort();
    for (const relativePath of relativePaths) {
      snapshot[`${status.id}/${relativePath}`] = await fileSha256(
        join(status.path, relativePath)
      );
    }
  }
  return snapshot;
}

/** Run connector resolution in a strict child so host env is never consulted. */
export async function snapshotInstalledConnectorBytes(
  options: ConnectorSnapshotOptions
): Promise<ConnectorByteSnapshot> {
  await assertPackageSmokeEnvironment(options.tempRoot, options.env);
  const inputPath = join(
    options.tempRoot,
    `connector-snapshot-${crypto.randomUUID()}.json`
  );
  await assertPackageSmokePathContained(
    options.tempRoot,
    inputPath,
    "connector snapshot input"
  );
  await Bun.write(inputPath, JSON.stringify(options));
  const result = Bun.spawnSync(
    [process.execPath, import.meta.path, "--child", inputPath],
    {
      cwd: options.cwd,
      env: options.env,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      [
        `Installed connector snapshot child exited ${result.exitCode}`,
        `stdout:\n${result.stdout?.toString() ?? "(empty)"}`,
        `stderr:\n${result.stderr?.toString() ?? "(empty)"}`,
      ].join("\n")
    );
  }
  return JSON.parse(result.stdout?.toString() ?? "{}") as ConnectorByteSnapshot;
}

async function runChild(inputPath: string): Promise<void> {
  const tempRoot = process.env.GNO_PACKAGE_SMOKE_TEMP_ROOT ?? "";
  await assertPackageSmokePathContained(
    tempRoot,
    inputPath,
    "connector snapshot input"
  );
  const options = (await Bun.file(
    inputPath
  ).json()) as ConnectorSnapshotOptions;
  if (options.tempRoot !== tempRoot) {
    throw new Error("Connector snapshot child temp root mismatch");
  }
  for (const [key, value] of Object.entries(options.env)) {
    if (process.env[key] !== value) {
      throw new Error(`Connector snapshot child environment mismatch: ${key}`);
    }
  }
  const snapshot = await readInstalledConnectorBytes(options);
  process.stdout.write(JSON.stringify(snapshot));
}

if (import.meta.main) {
  const inputPath = process.argv[3];
  if (process.argv[2] !== "--child" || !inputPath) {
    throw new Error("Connector snapshot child requires --child <input>");
  }
  await runChild(inputPath);
}
