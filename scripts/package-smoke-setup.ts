/** Packed-install proof for verified lexical-first folder setup. */

import { join } from "node:path";

import { assertValid, loadSchema } from "../test/spec/schemas/validator";
import {
  snapshotInstalledConnectorBytes,
  verifyInstalledSetupContractsInChild,
} from "./package-smoke-setup-contract";
import { verifyPackedSetupFailures } from "./package-smoke-setup-failures";

interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface PackedSetupSmokeOptions {
  gnoBin: string;
  packageRoot: string;
  cwd: string;
  env: Record<string, string>;
  fixtureDir: string;
  runCommand: (
    command: string[],
    cwd: string,
    env: Record<string, string>
  ) => CommandResult;
}

interface SetupStage {
  status: string;
  token: string | null;
}

interface LexicalReceipt {
  schemaVersion: "1.0";
  status: string;
  generatedAt: string;
  input: {
    folderFingerprint: string;
  };
  fingerprints: {
    input: string;
    config: string | null;
    index: string | null;
  };
  collection: {
    name: string;
    disposition: string;
  };
  paths: {
    config: string;
    receipt: string;
  };
  stages: Record<string, SetupStage>;
  pending: string[];
  failure: unknown;
  activation: {
    ready: boolean;
    evidence: {
      resultUri: string;
      resultSourceHash: string;
    };
  };
}

interface SemanticReceipt {
  schemaVersion: "1.0";
  status: string;
  setupReceiptFingerprint: string;
  pid: number | null;
}

interface SetupCommandResult {
  schemaVersion: "1.0";
  status: "completed" | "failed";
  lexical: {
    receipt: LexicalReceipt | null;
    error: unknown;
  };
  semantic: SemanticReceipt | null;
}

interface ConnectorResult {
  connectorId: string;
  installation: string;
  verification: string;
  code: string;
  remediation: string;
  receipt: {
    fingerprint: string;
    stages: {
      connector: {
        status: string;
      };
    };
  } | null;
}

interface SetupActivationResult {
  schemaVersion: "1.0";
  status: "completed" | "completed_with_actions" | "failed";
  setup: SetupCommandResult;
  connectors: ConnectorResult[];
}

const CONNECTOR_IDS = [
  "claude-code-skill",
  "claude-desktop-mcp",
  "cursor-mcp",
  "codex-skill",
  "opencode-skill",
  "openclaw-skill",
  "hermes-skill",
] as const;
const SETUP_STAGE_ORDER = [
  "preflight",
  "config_saved",
  "store_synced",
  "lexical_indexed",
  "lexical_proved",
  "completed",
] as const;
const EXPECTED_RESULT_URI = "gno://package-smoke/package-setup-proof.md";
const CORPUS_TOKEN = "alpine-lantern-7429";

function parseJson<T>(stdout: string, label: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new Error(
      `${label} did not return JSON: ${
        error instanceof Error ? error.message : String(error)
      }\n${stdout}`
    );
  }
}

function requireCompletedSetup(
  result: SetupCommandResult,
  label: string
): {
  lexical: LexicalReceipt;
  semantic: SemanticReceipt;
} {
  const lexical = result.lexical.receipt;
  const semantic = result.semantic;
  if (
    result.status !== "completed" ||
    !lexical ||
    lexical.status !== "completed" ||
    !semantic ||
    result.lexical.error !== null
  ) {
    throw new Error(
      `${label} did not return completed lexical setup:\n${JSON.stringify(result, null, 2)}`
    );
  }
  return { lexical, semantic };
}

function assertLexicalProof(receipt: LexicalReceipt, label: string): void {
  const stageKeys = Object.keys(receipt.stages);
  const allStagesPassed = SETUP_STAGE_ORDER.every(
    (stage) => receipt.stages[stage]?.status === "passed"
  );
  if (
    receipt.schemaVersion !== "1.0" ||
    stageKeys.length !== SETUP_STAGE_ORDER.length ||
    !allStagesPassed ||
    receipt.pending.length !== 0 ||
    receipt.failure !== null ||
    receipt.activation.ready !== true ||
    receipt.activation.evidence.resultUri !== EXPECTED_RESULT_URI ||
    !/^[a-f0-9]{64}$/.test(receipt.activation.evidence.resultSourceHash)
  ) {
    throw new Error(
      `${label} did not prove the exact closed lexical receipt:\n${JSON.stringify(receipt, null, 2)}`
    );
  }
}

function connectorArgs(ids: readonly string[]): string[] {
  return ids.flatMap((id) => ["--connector", id]);
}

function assertConnectorProjection(
  result: SetupActivationResult,
  installation: "installed" | "reused"
): void {
  if (
    result.status !== "completed_with_actions" ||
    result.connectors.length !== CONNECTOR_IDS.length ||
    result.connectors.map(({ connectorId }) => connectorId).join(",") !==
      CONNECTOR_IDS.join(",")
  ) {
    throw new Error(
      `Packed connector composition has unexpected shape:\n${JSON.stringify(result, null, 2)}`
    );
  }
  for (const connector of result.connectors) {
    const isMcp =
      connector.connectorId === "claude-desktop-mcp" ||
      connector.connectorId === "cursor-mcp";
    const expectedVerification = isMcp ? "passed" : "skipped";
    const expectedCode = isMcp
      ? "connector_verified"
      : "target_runtime_unverifiable";
    if (
      connector.installation !== installation ||
      connector.verification !== expectedVerification ||
      connector.code !== expectedCode ||
      connector.receipt?.stages.connector.status !== expectedVerification
    ) {
      throw new Error(
        `Packed connector ${connector.connectorId} drifted:\n${JSON.stringify(connector, null, 2)}`
      );
    }
  }
  const serialized = JSON.stringify(result.connectors);
  if (
    serialized.includes(CORPUS_TOKEN) ||
    serialized.includes(result.setup.lexical.receipt?.paths.config ?? "\0")
  ) {
    throw new Error(
      "Packed connector projection leaked corpus text or a config path"
    );
  }
}

async function proveMalformedConfigPreservation(
  options: PackedSetupSmokeOptions
): Promise<void> {
  const cursorConfig = join(options.env.HOME ?? "", ".cursor", "mcp.json");
  const validConfig = await Bun.file(cursorConfig).text();
  const malformed = "{do-not-overwrite";
  await Bun.write(cursorConfig, malformed);
  const failed = parseJson<SetupActivationResult>(
    options.runCommand(
      [
        options.gnoBin,
        "setup",
        options.fixtureDir,
        "--name",
        "package-smoke",
        "--connector",
        "cursor-mcp",
        "--no-semantic",
        "--json",
      ],
      options.cwd,
      options.env
    ).stdout,
    "malformed connector setup"
  );
  if (
    failed.status !== "completed_with_actions" ||
    failed.connectors[0]?.code !== "connector_configuration_unavailable" ||
    failed.connectors[0]?.verification !== "not_run" ||
    (await Bun.file(cursorConfig).text()) !== malformed
  ) {
    throw new Error(
      `Malformed connector config was not preserved:\n${JSON.stringify(failed, null, 2)}`
    );
  }

  await Bun.write(cursorConfig, validConfig);
  const recovered = parseJson<SetupActivationResult>(
    options.runCommand(
      [
        options.gnoBin,
        "setup",
        options.fixtureDir,
        "--name",
        "package-smoke",
        "--connector",
        "cursor-mcp",
        "--no-semantic",
        "--json",
      ],
      options.cwd,
      options.env
    ).stdout,
    "recovered connector setup"
  );
  if (
    recovered.status !== "completed" ||
    recovered.connectors[0]?.installation !== "reused" ||
    recovered.connectors[0]?.verification !== "passed"
  ) {
    throw new Error(
      `Packed connector retry did not recover:\n${JSON.stringify(recovered, null, 2)}`
    );
  }
}

export async function verifyPackedFolderSetup(
  options: PackedSetupSmokeOptions
): Promise<void> {
  const sourcePath = join(options.fixtureDir, "package-setup-proof.md");
  await Bun.write(
    sourcePath,
    `# Package setup proof\n\nThe exact corpus token is ${CORPUS_TOKEN}.\n`
  );

  await verifyPackedSetupFailures(options);

  const firstResult = parseJson<SetupCommandResult>(
    options.runCommand(
      [
        options.gnoBin,
        "setup",
        options.fixtureDir,
        "--name",
        "package-smoke",
        "--no-semantic",
        "--json",
      ],
      options.cwd,
      options.env
    ).stdout,
    "first packed setup"
  );
  assertValid(firstResult, await loadSchema("setup-command-result"));
  const first = requireCompletedSetup(firstResult, "first packed setup");
  assertLexicalProof(first.lexical, "first packed setup");
  if (
    first.lexical.collection.disposition !== "created" ||
    first.semantic.status !== "skipped" ||
    first.semantic.pid !== null
  ) {
    throw new Error(
      `First packed setup did not prove create plus --no-semantic:\n${JSON.stringify(firstResult, null, 2)}`
    );
  }
  const persisted = parseJson<LexicalReceipt>(
    await Bun.file(first.lexical.paths.receipt).text(),
    "persisted setup receipt"
  );
  if (!Bun.deepEquals(persisted, first.lexical, true)) {
    throw new Error(
      "Packed setup stdout and canonical lexical receipt diverged"
    );
  }

  const allConnectorArgs = connectorArgs([...CONNECTOR_IDS, "codex-skill"]);
  const activated = parseJson<SetupActivationResult>(
    options.runCommand(
      [
        options.gnoBin,
        "setup",
        options.fixtureDir,
        "--name",
        "package-smoke",
        ...allConnectorArgs,
        "--no-semantic",
        "--json",
      ],
      options.cwd,
      options.env
    ).stdout,
    "first connector setup"
  );
  assertValid(activated, await loadSchema("setup-activation-result"));
  const activatedSetup = requireCompletedSetup(
    activated.setup,
    "first connector setup"
  );
  assertLexicalProof(activatedSetup.lexical, "first connector setup");
  assertConnectorProjection(activated, "installed");
  const connectorBytes = await snapshotInstalledConnectorBytes(
    options.packageRoot,
    {
      cwd: options.cwd,
      homeDir: options.env.HOME ?? "",
    }
  );
  if (
    activatedSetup.lexical.collection.disposition !== "reused" ||
    activatedSetup.semantic.status !== "skipped" ||
    activatedSetup.semantic.pid !== null ||
    activatedSetup.semantic.setupReceiptFingerprint !==
      first.semantic.setupReceiptFingerprint
  ) {
    throw new Error(
      "Packed setup rerun changed semantic source identity or worker ownership"
    );
  }

  const rerun = parseJson<SetupActivationResult>(
    options.runCommand(
      [
        options.gnoBin,
        "setup",
        options.fixtureDir,
        "--name",
        "package-smoke",
        ...allConnectorArgs,
        "--no-semantic",
        "--json",
      ],
      options.cwd,
      options.env
    ).stdout,
    "connector rerun"
  );
  assertValid(rerun, await loadSchema("setup-activation-result"));
  assertConnectorProjection(rerun, "reused");
  const rerunSetup = requireCompletedSetup(rerun.setup, "connector rerun");
  if (
    rerunSetup.semantic.setupReceiptFingerprint !==
      first.semantic.setupReceiptFingerprint ||
    rerunSetup.semantic.pid !== null
  ) {
    throw new Error(
      "Packed idempotent rerun changed semantic identity or spawned work"
    );
  }
  for (const connector of rerun.connectors) {
    const previous = activated.connectors.find(
      ({ connectorId }) => connectorId === connector.connectorId
    );
    if (connector.receipt?.fingerprint !== previous?.receipt?.fingerprint) {
      throw new Error(
        `Packed connector receipt was not reused: ${connector.connectorId}`
      );
    }
  }
  const rerunConnectorBytes = await snapshotInstalledConnectorBytes(
    options.packageRoot,
    {
      cwd: options.cwd,
      homeDir: options.env.HOME ?? "",
    }
  );
  if (!Bun.deepEquals(rerunConnectorBytes, connectorBytes, true)) {
    throw new Error("Packed connector rerun changed installed bytes");
  }

  await proveMalformedConfigPreservation(options);
  await verifyInstalledSetupContractsInChild({
    packageRoot: options.packageRoot,
    fixtureDir: options.fixtureDir,
    configPath: first.lexical.paths.config,
    dataDir: options.env.GNO_DATA_DIR ?? "",
    lexicalReceipt: first.lexical as never,
  });
}
