/** Installed semantic-setup ownership proof beside the packed resident. */

// node:path has no Bun path utilities.
import { join } from "node:path";
// node:url converts the installed package path to a portable dynamic import URL.
import { pathToFileURL } from "node:url";

import { assertValid, loadSchema } from "../test/spec/schemas/validator";
import {
  isRecord,
  residentOwnershipState,
  type ResidentSmokeInput,
  validateResidentStatusSurface,
} from "./package-smoke-resident-support";

interface SemanticSetupHelperInput {
  packageRoot: string;
  fixtureDir: string;
  configPath: string;
  dataDir: string;
  readyPath: string;
  releasePath: string;
}

interface SemanticSetupHelperOutput {
  exitCode: number;
  result: {
    schemaVersion: string;
    status: string;
    lexical: {
      receipt: {
        activation: { ready: boolean; evidence: { resultUri: string } } | null;
      } | null;
      error: unknown;
    };
    semantic: {
      status: string;
      jobId: string;
      pid: number | null;
      receiptPath: string;
    } | null;
  };
}

const START_TIMEOUT_MS = 15_000;

async function waitForFile(path: string, label: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function runInstalledSemanticSetupHelper(
  input: SemanticSetupHelperInput
): Promise<void> {
  const moduleUrl = (relativePath: string): string =>
    pathToFileURL(join(input.packageRoot, relativePath)).href;
  const setupModule = (await import(
    moduleUrl("src/cli/commands/setup.ts")
  )) as typeof import("../src/cli/commands/setup");
  const semanticModule = (await import(
    moduleUrl("src/cli/commands/setup-semantic.ts")
  )) as typeof import("../src/cli/commands/setup-semantic");

  const outcome = await setupModule.setup({
    folder: input.fixtureDir,
    name: "package-smoke",
    configPath: input.configPath,
    offline: true,
    yes: true,
    json: true,
    // `semantic` is intentionally omitted: exercise the enabled-by-default
    // setup path while replacing only the model-bearing process spawn.
    scheduleSemanticFn: (options) =>
      semanticModule.scheduleSetupSemantic({
        ...options,
        dataDir: input.dataDir,
        spawnWorker: async () => ({ pid: process.pid }),
        processIsAlive: (pid) => pid === process.pid,
      }),
  });
  await Bun.write(
    input.readyPath,
    JSON.stringify({ exitCode: outcome.exitCode, result: outcome.result })
  );
  await waitForFile(input.releasePath, "semantic setup helper release");
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error);
}

/** Prove semantic-default setup owns one process without resident mutation. */
export async function proveResidentUnaffectedBySemanticSetup(
  input: ResidentSmokeInput,
  baseUrl: string
): Promise<void> {
  const forbidden = [
    input.cwd,
    input.env.GNO_DATA_DIR ?? "",
    "package-smoke-secret",
  ];
  const before = await validateResidentStatusSurface(
    baseUrl,
    "serve",
    forbidden
  );
  const helperId = crypto.randomUUID();
  const helperInputPath = join(input.cwd, `semantic-setup-${helperId}.json`);
  const readyPath = join(input.cwd, `semantic-setup-${helperId}.ready.json`);
  const releasePath = join(input.cwd, `semantic-setup-${helperId}.release`);
  const helperInput: SemanticSetupHelperInput = {
    packageRoot: input.packageRoot,
    fixtureDir: input.fixtureDir,
    configPath: join(input.env.GNO_CONFIG_DIR ?? "", "index.yml"),
    dataDir: input.env.GNO_DATA_DIR ?? "",
    readyPath,
    releasePath,
  };
  await Bun.write(helperInputPath, JSON.stringify(helperInput));
  const helper = Bun.spawn(
    [process.execPath, import.meta.path, "semantic-setup", helperInputPath],
    {
      cwd: input.cwd,
      env: { ...process.env, ...input.env, NODE_ENV: "production" },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const stdout = new Response(helper.stdout).text();
  const stderr = new Response(helper.stderr).text();
  let proofError: unknown = null;
  let exitCode: number | null = null;
  let helperStdout = "";
  let helperStderr = "";
  try {
    await waitForFile(readyPath, "installed semantic setup ownership");
    const output = (await Bun.file(
      readyPath
    ).json()) as SemanticSetupHelperOutput;
    assertValid(output.result, await loadSchema("setup-command-result"));
    const semantic = output.result.semantic;
    const lexical = output.result.lexical.receipt;
    const semanticRoot = join(helperInput.dataDir, "setup-semantic", "default");
    if (
      output.exitCode !== 0 ||
      output.result.status !== "completed" ||
      output.result.lexical.error !== null ||
      lexical?.activation?.ready !== true ||
      !lexical.activation.evidence.resultUri.startsWith("gno://") ||
      semantic?.status !== "scheduled" ||
      semantic.pid !== helper.pid ||
      !semantic.receiptPath.startsWith(`${semanticRoot}/`) ||
      !semantic.receiptPath.endsWith(".json")
    ) {
      throw new Error(
        `Installed semantic-enabled setup lost standalone ownership:\n${JSON.stringify(output, null, 2)}`
      );
    }
    const persistedSemantic: unknown = await Bun.file(
      semantic.receiptPath
    ).json();
    assertValid(persistedSemantic, await loadSchema("setup-semantic-receipt"));
    if (
      !isRecord(persistedSemantic) ||
      persistedSemantic.status !== "scheduled" ||
      persistedSemantic.jobId !== semantic.jobId ||
      persistedSemantic.pid !== helper.pid ||
      helper.exitCode !== null
    ) {
      throw new Error(
        "Installed semantic setup receipt did not preserve its live one-shot PID"
      );
    }
    const after = await validateResidentStatusSurface(
      baseUrl,
      "serve",
      forbidden
    );
    if (
      JSON.stringify(residentOwnershipState(after)) !==
      JSON.stringify(residentOwnershipState(before))
    ) {
      throw new Error(
        "Semantic-enabled direct setup attached to or mutated resident ownership"
      );
    }
  } catch (error) {
    proofError = error;
  } finally {
    await Bun.write(releasePath, "release\n");
    exitCode = await helper.exited;
    [helperStdout, helperStderr] = await Promise.all([stdout, stderr]);
  }
  if (proofError) {
    throw new Error(
      `Semantic setup ownership proof failed: ${formatUnknownError(proofError)}\nhelper exit ${exitCode}\nstdout:\n${helperStdout}\nstderr:\n${helperStderr}`
    );
  }
  if (exitCode !== 0) {
    throw new Error(
      `Semantic setup helper exited ${exitCode}\nstdout:\n${helperStdout}\nstderr:\n${helperStderr}`
    );
  }
}

if (import.meta.main && process.argv[2] === "semantic-setup") {
  const inputPath = process.argv[3];
  if (!inputPath) {
    throw new Error("Semantic setup helper requires an input path");
  }
  try {
    await runInstalledSemanticSetupHelper(
      (await Bun.file(inputPath).json()) as SemanticSetupHelperInput
    );
    process.exit(0);
  } catch (error) {
    const message =
      error instanceof Error
        ? (error.stack ?? `${error.name}: ${error.message}`)
        : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
