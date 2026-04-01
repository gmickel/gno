// node:fs/promises: recursive build artifact walk/mkdir for packaging proof (no Bun equivalent).
import { mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  DEFAULT_GNO_RUNTIME_FOLDER,
  getPackagedRuntimeDir,
} from "../src/shared/runtime-layout";

interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
}

interface DoctorResult {
  healthy: boolean;
  checks: DoctorCheck[];
}

const shellRoot = resolve(import.meta.dir, "..");
const defaultBuildDir = join(shellRoot, "build");
const defaultArtifactDir = join(shellRoot, "artifacts");

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    paths.push(fullPath);
    if (entry.isDirectory()) {
      paths.push(...(await walk(fullPath)));
    }
  }
  return paths;
}

async function findFirst(
  root: string,
  predicate: (path: string) => boolean
): Promise<string | null> {
  const paths = await walk(root);
  return paths.find(predicate) ?? null;
}

function expectTruthy<T>(value: T | null | undefined, label: string): T {
  if (!value) {
    throw new Error(`Missing required packaged runtime path: ${label}`);
  }
  return value;
}

function getRequiredCheck(result: DoctorResult, name: string): DoctorCheck {
  const check = result.checks.find((candidate) => candidate.name === name);
  if (!check) {
    throw new Error(`doctor output missing ${name} check`);
  }
  return check;
}

function runCommand(
  cmd: string[],
  cwd: string,
  env: Record<string, string>
): { stdout: string; stderr: string } {
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
      `Command failed (${cmd.join(" ")}): exit ${result.exitCode}\n${stderr || stdout}`
    );
  }
  return { stdout, stderr };
}

async function verify(): Promise<void> {
  const buildDir = resolve(process.env.ELECTROBUN_BUILD_DIR ?? defaultBuildDir);
  const artifactDir = resolve(
    process.env.ELECTROBUN_ARTIFACT_DIR ?? defaultArtifactDir
  );

  const buildStat = await stat(buildDir).catch(() => null);
  if (!buildStat?.isDirectory()) {
    throw new Error(`Build directory not found: ${buildDir}`);
  }

  const buildJsonPath = expectTruthy(
    await findFirst(buildDir, (path) =>
      path.endsWith(`${process.platform === "win32" ? "\\" : "/"}build.json`)
    ),
    "build.json"
  );
  const resourcesDir = dirname(buildJsonPath);
  const runtimeDir = getPackagedRuntimeDir(
    resourcesDir,
    process.env.GNO_ELECTROBUN_RUNTIME_FOLDER ?? DEFAULT_GNO_RUNTIME_FOLDER
  );
  const runtimeEntrypoint = join(runtimeDir, "src", "index.ts");

  const bunPath = expectTruthy(
    await findFirst(buildDir, (path) =>
      path.endsWith(process.platform === "win32" ? "\\bun.exe" : "/bun")
    ),
    "bundled bun binary"
  );
  const launcherPath = expectTruthy(
    await findFirst(buildDir, (path) =>
      path.endsWith(
        process.platform === "win32" ? "\\launcher.exe" : "/launcher"
      )
    ),
    "launcher"
  );

  const tempRoot = await mkdtemp(join(tmpdir(), "gno-packaged-runtime-"));
  const notesDir = join(tempRoot, "notes");
  const configDir = join(tempRoot, "config");
  const dataDir = join(tempRoot, "data");
  const cacheDir = join(tempRoot, "cache");

  await mkdir(notesDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true });
  await Bun.write(
    join(notesDir, "hello.md"),
    "# Hello\n\nPackaged runtime proof.\n"
  );

  const sharedEnv = {
    GNO_CACHE_DIR: cacheDir,
    GNO_CONFIG_DIR: configDir,
    GNO_DATA_DIR: dataDir,
    GNO_NO_AUTO_DOWNLOAD: "1",
    HF_HUB_OFFLINE: "1",
  };

  runCommand(
    [bunPath, runtimeEntrypoint, "init", notesDir, "--name", "notes"],
    runtimeDir,
    sharedEnv
  );
  runCommand(
    [bunPath, runtimeEntrypoint, "update", "--yes"],
    runtimeDir,
    sharedEnv
  );
  const doctor = JSON.parse(
    runCommand(
      [bunPath, runtimeEntrypoint, "doctor", "--json"],
      runtimeDir,
      sharedEnv
    ).stdout
  ) as DoctorResult;
  const search = JSON.parse(
    runCommand(
      [bunPath, runtimeEntrypoint, "search", "packaged runtime", "--json"],
      runtimeDir,
      sharedEnv
    ).stdout
  ) as { results?: Array<unknown> };

  if (getRequiredCheck(doctor, "sqlite-fts5").status !== "ok") {
    throw new Error("Packaged runtime failed sqlite-fts5 check");
  }
  if (getRequiredCheck(doctor, "fts5-snowball").status !== "ok") {
    throw new Error("Packaged runtime failed fts5-snowball check");
  }
  if (getRequiredCheck(doctor, "sqlite-vec").status !== "ok") {
    throw new Error("Packaged runtime failed sqlite-vec check");
  }
  if (!search.results?.length) {
    throw new Error("Packaged runtime BM25 search returned no results");
  }

  runCommand([launcherPath], dirname(launcherPath), {
    ...sharedEnv,
    GNO_ELECTROBUN_CONTROL_PORT: "49528",
    GNO_ELECTROBUN_PORT: "49527",
    GNO_ELECTROBUN_SELFTEST: "1",
  });

  await Bun.write(
    join(artifactDir, `packaged-runtime-proof-${process.platform}.json`),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        buildDir,
        bunPath,
        launcherPath,
        resourcesDir,
        runtimeDir,
        doctor,
      },
      null,
      2
    )
  );

  console.log("[gno-electrobun] packaged runtime proof complete");
}

await verify();
