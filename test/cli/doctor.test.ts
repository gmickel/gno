import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActivationStatus } from "../../src/core/activation-status";

import { getIndexDbPath } from "../../src/app/constants";
import { hasCriticalDoctorErrors } from "../../src/cli/commands/doctor";
import {
  checkConnectorActivation,
  checkRetrievalActivation,
} from "../../src/cli/commands/doctor-activation";
import { runCli } from "../../src/cli/run";
import { getConfigPaths } from "../../src/config";
import { loadConfigFromPath } from "../../src/config/loader";
import { saveConfigToPath } from "../../src/config/saver";
import { isConnectorActivationComplete } from "../../src/core/activation-connector-health";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

let stdoutData = "";
let stderrData = "";
let testDir = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  stdoutData = "";
  stderrData = "";
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  try {
    const code = await runCli(["bun", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "gno-doctor-activation-"));
  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");
});

afterEach(async () => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
  Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
  Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
  await safeRm(testDir);
});

describe("gno doctor activation exit semantics", () => {
  test("fails process health for non-activation errors but not connector warnings", () => {
    expect(
      hasCriticalDoctorErrors([
        {
          name: "retrieval-activation",
          status: "ok",
          message: "1 collection passed lexical retrieval proof",
        },
        {
          name: "sqlite-fts5",
          status: "error",
          message: "FTS5 not available (required)",
        },
      ])
    ).toBe(true);

    expect(
      hasCriticalDoctorErrors([
        {
          name: "retrieval-activation",
          status: "ok",
          message: "1 collection passed lexical retrieval proof",
        },
        {
          name: "connector-activation",
          status: "warn",
          message: "1 connector proof failed",
        },
      ])
    ).toBe(false);
  });

  test("writes one JSON result and exits 2 silently when lexical proof fails", async () => {
    const notesDir = join(testDir, "notes");
    await mkdir(notesDir, { recursive: true });
    await Bun.write(join(notesDir, "a.md"), "# Alpha\n\nQuartzite ledger.\n");
    expect((await cli("init", notesDir, "--name", "notes")).code).toBe(0);
    expect((await cli("update")).code).toBe(0);
    // Drop the lexical rows so the proof fails with index_out_of_sync.
    const config = await loadConfigFromPath(getConfigPaths().configFile);
    if (!config.ok) throw new Error("Expected a loadable config");
    const store = new SqliteAdapter();
    const opened = await store.open(
      getIndexDbPath(),
      config.value.ftsTokenizer,
      config.value.busyTimeoutMs
    );
    if (!opened.ok) throw new Error("Expected the index to open");
    try {
      store.getRawDb().run("DELETE FROM documents_fts");
    } finally {
      await store.close();
    }

    const result = await cli("doctor", "--json");
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.activation).toMatchObject({ usable: false, healthy: false });
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({
        name: "retrieval-activation",
        status: "error",
      })
    );
  });

  test("reports a collection with no documents as informational, not a failure", async () => {
    const emptyDir = join(testDir, "empty");
    await mkdir(emptyDir, { recursive: true });
    expect((await cli("init", emptyDir, "--name", "empty")).code).toBe(0);

    const result = await cli("doctor", "--json");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.activation).toMatchObject({ usable: false, healthy: true });
    expect(parsed.activation.collections[0].remediation).toMatchObject({
      code: "no_documents",
      command: "gno update",
    });
    const check = parsed.checks.find(
      ({ name }: { name: string }) => name === "retrieval-activation"
    );
    expect(check).toMatchObject({
      status: "info",
      message: "No documents indexed yet in 1 collection",
    });
    expect(result.code).toBe(hasCriticalDoctorErrors(parsed.checks) ? 2 : 0);
  });

  test("lists empty collections beside passing and failing ones", () => {
    const collection = (
      name: string,
      ready: boolean,
      code?: "no_documents" | "retrieval_mismatch"
    ) => ({
      collection: name,
      ready,
      generatedAt: null,
      stages: {} as never,
      semanticAvailability: {
        status: "pending" as const,
        code: "semantic_not_checked" as const,
        command: "gno status",
      },
      remediation: code
        ? {
            stage:
              code === "no_documents"
                ? ("index" as const)
                : ("lexical" as const),
            code,
            command:
              code === "no_documents"
                ? "gno update"
                : `gno index ${name} --no-embed`,
            message: "",
          }
        : null,
    });
    const activation = (
      healthy: boolean,
      collections: ReturnType<typeof collection>[]
    ) => ({
      schemaVersion: "1.0" as const,
      usable: collections.some(({ ready }) => ready),
      healthy,
      collections,
      connectors: [],
      connectorProjection: { total: 0, projected: 0, truncated: false },
    });

    expect(
      checkRetrievalActivation(
        activation(true, [
          collection("docs", true),
          collection("inbox", false, "no_documents"),
        ])
      )
    ).toMatchObject({
      status: "info",
      message:
        "1 collection passed lexical retrieval proof; 1 collection with no documents yet",
      details: expect.arrayContaining([
        "inbox: no documents indexed yet (informational)",
        "Add files, then run: gno update",
      ]),
    });
    expect(
      checkRetrievalActivation(
        activation(false, [
          collection("docs", true),
          collection("inbox", false, "no_documents"),
          collection("wiki", false, "retrieval_mismatch"),
        ])
      )
    ).toMatchObject({
      status: "error",
      message: "1 collection failed lexical retrieval proof",
      details: [
        "wiki: lexical/retrieval_mismatch",
        "Run: gno index wiki --no-embed",
        "inbox: no documents indexed yet (informational)",
        "Add files, then run: gno update",
      ],
    });
  });

  test.each([
    {
      label: "unevaluated",
      omitted: undefined,
      status: "warn",
      message: "64 of 85 connector target/collection checks projected",
      detail: "21 target/collection checks were omitted",
    },
    {
      label: "evaluated and passing",
      omitted: { passed: 21, failed: 0, incomplete: 0, notApplicable: 0 },
      status: "ok",
      message: "85 connector proofs passed (64 of 85 checks listed)",
      detail: "21 more target/collection checks are not listed: 21 passed.",
    },
    {
      label: "evaluated with an unlisted failure",
      omitted: { passed: 20, failed: 1, incomplete: 0, notApplicable: 0 },
      status: "warn",
      message: "1 connector proof pending or failed (64 of 85 checks listed)",
      detail:
        "21 more target/collection checks are not listed: 20 passed, 1 failed.",
    },
  ])(
    "decides bounded connector projections from omitted pairs: $label",
    ({ omitted, status, message, detail }) => {
      const activation: ActivationStatus = {
        schemaVersion: "1.0",
        usable: true,
        healthy: true,
        collections: [],
        connectors: Array.from({ length: 64 }, (_, index) => ({
          collection: "notes",
          target: index === 0 ? "cursor-mcp" : `connector-${index}`,
          status: "passed",
          remediation: null,
        })),
        connectorProjection: {
          total: 85,
          projected: 64,
          truncated: true,
          ...(omitted ? { omitted } : {}),
        },
      };
      const check = checkConnectorActivation(activation);

      expect(check).toMatchObject({ status, message });
      expect(check?.details?.[0]).toContain(detail);
      expect(isConnectorActivationComplete(activation)).toBe(status === "ok");
    }
  );

  test("does not describe known vector unavailability as pending", () => {
    const check = checkRetrievalActivation({
      schemaVersion: "1.0",
      usable: true,
      healthy: true,
      collections: [
        {
          collection: "notes",
          ready: true,
          generatedAt: null,
          stages: {} as never,
          semanticAvailability: {
            status: "skipped",
            code: "vector_unavailable",
            command: "gno doctor",
          },
          remediation: null,
        },
      ],
      connectors: [],
      connectorProjection: { total: 0, projected: 0, truncated: false },
    });

    expect(check.details).toEqual([
      "Semantic retrieval remains separate (vector_unavailable).",
    ]);
    expect(check.details?.join(" ")).not.toContain("pending");
  });

  test("reports the live sqlite busy_timeout in human and json output", async () => {
    const emptyDir = join(testDir, "empty");
    await mkdir(emptyDir, { recursive: true });
    expect((await cli("init", emptyDir, "--name", "empty")).code).toBe(0);

    const jsonResult = await cli("doctor", "--json");
    const parsed = JSON.parse(jsonResult.stdout) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({
        name: "busy-timeout",
        status: "ok",
        message: expect.stringContaining("60000"),
      })
    );

    const humanResult = await cli("doctor");
    expect(humanResult.stdout).toContain("busy-timeout");
    expect(humanResult.stdout).toContain("60000");
  });

  test("doctor busy_timeout reflects the configured pragma, not a config echo", async () => {
    const notesDir = join(testDir, "notes");
    await mkdir(notesDir, { recursive: true });
    await Bun.write(join(notesDir, "note.md"), "# Note\nhello\n");
    expect((await cli("init", notesDir, "--name", "notes")).code).toBe(0);

    const configPath = getConfigPaths().configFile;
    const loaded = await loadConfigFromPath(configPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    const saved = await saveConfigToPath(
      { ...loaded.value, busyTimeoutMs: 45_000 },
      configPath
    );
    expect(saved.ok).toBe(true);

    const jsonResult = await cli("doctor", "--json");
    const parsed = JSON.parse(jsonResult.stdout) as {
      checks: Array<{ name: string; status: string; message: string }>;
    };
    const check = parsed.checks.find(({ name }) => name === "busy-timeout");
    expect(check).toMatchObject({
      name: "busy-timeout",
      status: "ok",
      message: "busy_timeout 45000ms",
    });
  });

  test("keeps the store open until a healthy lexical proof completes", async () => {
    const notesDir = join(testDir, "notes");
    await mkdir(notesDir, { recursive: true });
    await Bun.write(
      join(notesDir, "proof.md"),
      "# Proof\npackagedactivationneedle confirms local retrieval."
    );
    expect((await cli("init", notesDir, "--name", "notes")).code).toBe(0);
    expect((await cli("update", "--yes")).code).toBe(0);

    const result = await cli("doctor", "--json");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).activation).toMatchObject({
      usable: true,
      healthy: true,
      collections: [{ collection: "notes", ready: true }],
    });
  });
});
