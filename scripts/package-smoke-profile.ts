/** Packed-install proof for project-local retrieval profiles. */

// node:fs/promises provides recursive directory creation; Bun has no equivalent structural API.
import { mkdir } from "node:fs/promises";
// node:path provides path joining; Bun has no path utilities.
import { join } from "node:path";

import { assertValid, loadSchema } from "../test/spec/schemas/validator";

interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface PackedProfileSmokeOptions {
  gnoBin: string;
  cwd: string;
  env: Record<string, string>;
  runCommand: (
    command: string[],
    cwd: string,
    env: Record<string, string>
  ) => CommandResult;
}

interface ProfileCommandResult {
  command: "check" | "diff";
  status: "valid";
  valid: true;
  profile: { fingerprint: string };
}

interface ProfileApplyResult {
  command: "apply";
  status: "applied" | "unchanged";
  applied: boolean;
  receipt: { profile: { fingerprint: string } } | null;
}

interface SetupProfileResult {
  status: "completed" | "completed_with_actions";
  profile: {
    check: ProfileCommandResult;
    apply: ProfileApplyResult | null;
  };
  setup: {
    status: "completed";
    lexical: {
      receipt: {
        collection: { name: string };
        activation: { ready: boolean };
      } | null;
    };
  };
}

const parseJson = <T>(stdout: string, label: string): T => {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new Error(
      `${label} did not return JSON: ${
        error instanceof Error ? error.message : String(error)
      }\n${stdout}`
    );
  }
};

export async function verifyPackedProjectProfile(
  options: PackedProfileSmokeOptions
): Promise<void> {
  const projectRoot = join(options.cwd, "profile-project");
  await mkdir(join(projectRoot, ".gno"), { recursive: true });
  await mkdir(join(projectRoot, "notes"), { recursive: true });
  await Bun.write(
    join(projectRoot, "notes", "profile-proof.md"),
    "# Profile proof\n\nThe local profile corpus token is citrine-compass-8231.\n"
  );
  await Bun.write(
    join(projectRoot, ".gno", "index.yml"),
    [
      'schemaVersion: "1.0"',
      "collection:",
      "  name: packed-profile",
      "  root: notes",
      "  include:",
      '    - "**/*.md"',
      "  exclude:",
      '    - "private/**"',
      "contexts:",
      "  - text: Packed project profile context.",
      "contentTypes: []",
      "affinityDefaults:",
      "  enabled: true",
      "  contribution: 0.02",
      "recommendedCapabilities: []",
      "",
    ].join("\n")
  );

  const check = parseJson<ProfileCommandResult>(
    options.runCommand(
      [options.gnoBin, "profile", "check", projectRoot, "--json"],
      options.cwd,
      options.env
    ).stdout,
    "packed profile check"
  );
  assertValid(check, await loadSchema("project-profile-command"));
  if (check.command !== "check" || check.status !== "valid" || !check.valid) {
    throw new Error(
      `Packed profile check did not validate:\n${JSON.stringify(check, null, 2)}`
    );
  }

  const diff = parseJson<ProfileCommandResult>(
    options.runCommand(
      [options.gnoBin, "profile", "diff", projectRoot, "--json"],
      options.cwd,
      options.env
    ).stdout,
    "packed profile diff"
  );
  assertValid(diff, await loadSchema("project-profile-command"));
  if (
    diff.command !== "diff" ||
    diff.status !== "valid" ||
    diff.profile.fingerprint !== check.profile.fingerprint
  ) {
    throw new Error(
      `Packed profile diff drifted from check:\n${JSON.stringify(diff, null, 2)}`
    );
  }

  const firstApply = parseJson<ProfileApplyResult>(
    options.runCommand(
      [options.gnoBin, "profile", "apply", projectRoot, "--json"],
      options.cwd,
      options.env
    ).stdout,
    "packed profile apply"
  );
  assertValid(firstApply, await loadSchema("project-profile-apply"));
  if (
    firstApply.status !== "applied" ||
    !firstApply.applied ||
    firstApply.receipt?.profile.fingerprint !== check.profile.fingerprint
  ) {
    throw new Error(
      `Packed profile apply did not persist the profile:\n${JSON.stringify(firstApply, null, 2)}`
    );
  }

  const secondApply = parseJson<ProfileApplyResult>(
    options.runCommand(
      [options.gnoBin, "profile", "apply", projectRoot, "--json"],
      options.cwd,
      options.env
    ).stdout,
    "packed profile apply rerun"
  );
  assertValid(secondApply, await loadSchema("project-profile-apply"));
  if (secondApply.status !== "unchanged" || secondApply.applied) {
    throw new Error(
      `Packed profile apply was not idempotent:\n${JSON.stringify(secondApply, null, 2)}`
    );
  }

  const setup = parseJson<SetupProfileResult>(
    options.runCommand(
      [
        options.gnoBin,
        "setup",
        projectRoot,
        "--apply-profile",
        "--no-semantic",
        "--json",
      ],
      options.cwd,
      options.env
    ).stdout,
    "packed setup with profile"
  );
  assertValid(setup, await loadSchema("setup-profile-result"));
  if (
    setup.setup.status !== "completed" ||
    setup.setup.lexical.receipt?.collection.name !== "packed-profile" ||
    !setup.setup.lexical.receipt.activation.ready ||
    setup.profile.apply?.status !== "unchanged"
  ) {
    throw new Error(
      `Packed setup did not apply and prove the profile:\n${JSON.stringify(setup, null, 2)}`
    );
  }
}
