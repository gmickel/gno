import { expect, test } from "bun:test";
// Bun has no directory lifecycle API or OS/path helpers.
import { mkdir, mkdtemp, rm, symlink, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcceptanceRecord } from "../../../evals/acceptance/records";

import {
  ACCEPTANCE_SCHEMA_VERSION,
  acceptanceManifestFingerprint,
  type AcceptanceManifest,
} from "../../../evals/acceptance/manifest";
import {
  parseAcceptanceArgs,
  runAcceptanceCommand,
} from "../../../scripts/retrieval-acceptance";
import { verifyAcceptanceSource } from "../../../scripts/retrieval-acceptance-source";

const hash = "a".repeat(64);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "acceptance-command-"));
  const baseline: AcceptanceManifest = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    role: "baseline",
    identity: {
      commit: "a".repeat(40),
      indexId: "baseline",
      indexSha256: hash,
      bunVersion: Bun.version,
      nativeDependencies: {},
      platform: process.platform,
      architecture: process.arch,
    },
    fixtureVersion: "test",
    fixtures: [{ path: "fixture.json", sha256: hash }],
    models: [],
    cases: [
      {
        caseId: "test",
        fixtureSha256: hash,
        surface: "sdk",
        preset: "test",
        configuration: {},
      },
    ],
    intendedDeltas: [],
  };
  const candidate = structuredClone(baseline);
  candidate.role = "candidate";
  candidate.identity.indexId = "candidate";
  const record: AcceptanceRecord = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    manifestSha256: acceptanceManifestFingerprint(baseline),
    caseId: "test",
    deterministic: {
      scope: { collection: "allowed" },
      results: [],
      citations: [],
      modelInputs: [],
      semanticState: {
        status: "ok",
        vectorsUsed: false,
        vectorStatus: "not-requested",
        error: null,
        fallbacks: [],
        verification: null,
      },
    },
    generatedAnswer: null,
    transport: {},
  };
  const other = {
    ...record,
    manifestSha256: acceptanceManifestFingerprint(candidate),
  };
  const config = {
    mode: "compare",
    baselineManifest: join(root, "baseline.json"),
    candidateManifest: join(root, "candidate.json"),
    baselineRecords: join(root, "a.json"),
    candidateRecords: join(root, "b.json"),
    output: join(root, "report.json"),
  };
  for (const [path, value] of [
    [config.baselineManifest, baseline],
    [config.candidateManifest, candidate],
    [config.baselineRecords, [record]],
    [config.candidateRecords, [other]],
  ] as const)
    await Bun.write(path, JSON.stringify(value));
  const configPath = join(root, "run.json");
  await Bun.write(configPath, JSON.stringify(config));
  return { root, config, configPath, baseline, candidate, record, other };
}

test("strict command arguments preserve explicit native opt-in", () => {
  expect(parseAcceptanceArgs(["--config", "/a.json", "--native"])?.native).toBe(
    true
  );
  expect(parseAcceptanceArgs(["--config", "/a.json"])?.native).toBe(false);
  for (const args of [
    [],
    ["--config", "relative.json"],
    ["--config", "/a", "--native", "--native"],
    ["--config", "/a", "--unknown"],
  ])
    expect(() => parseAcceptanceArgs(args)).toThrow();
});

test("offline compare accepts unchanged records and rejects deterministic scope loss", async () => {
  const f = await fixture();
  try {
    expect(await runAcceptanceCommand(["--config", f.configPath])).toBe(0);
    expect((await Bun.file(f.config.output).json()).nativeCoverage).toBe(
      "not-run"
    );
    const changed = structuredClone(f.other);
    changed.deterministic.scope = { collection: "leaked" };
    await Bun.write(f.config.candidateRecords, JSON.stringify([changed]));
    await Bun.write(
      f.configPath,
      JSON.stringify({ ...f.config, output: join(f.root, "negative.json") })
    );
    expect(await runAcceptanceCommand(["--config", f.configPath])).toBe(1);
    expect(
      (await Bun.file(join(f.root, "negative.json")).json()).failures[0].field
    ).toBe("deterministic.scope.collection");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("invalid and mismatched manifests fail before reading records or launching", async () => {
  const f = await fixture();
  try {
    await Bun.write(
      f.configPath,
      JSON.stringify({
        ...f.config,
        baselineRecords: join(f.root, "does-not-exist"),
      })
    );
    for (const [value, error] of [
      [
        { ...f.candidate, fixtureVersion: "drift" },
        "incompatible baseline/candidate identity",
      ],
      [{ ...f.candidate, role: "wrong" }, "Invalid option"],
    ] as const) {
      await Bun.write(f.config.candidateManifest, JSON.stringify(value));
      await expect(
        runAcceptanceCommand(["--config", f.configPath])
      ).rejects.toThrow(error);
      expect(await Bun.file(f.config.output).exists()).toBe(false);
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("native mode cannot run from a config alone", async () => {
  const f = await fixture();
  try {
    const side = {
      sourceRoot: f.root,
      isolatedRoot: f.root,
      protocolRoot: join(f.root, "protocol"),
      configPath: join(f.root, "config.json"),
      dbPath: join(f.root, "db.sqlite"),
      cacheDir: join(f.root, "cache"),
    };
    const { baselineManifest, candidateManifest, output } = f.config;
    await Bun.write(
      f.configPath,
      JSON.stringify({
        mode: "native",
        baselineManifest,
        candidateManifest,
        output,
        fixtureRoot: f.root,
        baseline: side,
        candidate: side,
        requests: [
          {
            caseId: "test",
            query: "test",
            operation: "hybrid",
            options: {},
            expectedBackend: "cuda",
          },
        ],
        seed: 1,
        strata: ["warm"],
      })
    );
    await expect(
      runAcceptanceCommand(["--config", f.configPath])
    ).rejects.toThrow("--native opt-in");
    expect(await Bun.file(output).exists()).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("executable returns a nonpassing exit for invalid config without a receipt", async () => {
  const f = await fixture();
  try {
    await Bun.write(
      f.configPath,
      JSON.stringify({ ...f.config, mode: "unsupported" })
    );
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../../scripts/retrieval-acceptance.ts"),
        "--config",
        f.configPath,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("No matching discriminator");
    expect(await Bun.file(f.config.output).exists()).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("source identity rejects actual runtime and archive link mutations, tolerating extraction timestamps", async () => {
  const root = await mkdtemp(join(tmpdir(), "acceptance-source-"));
  const sourceRoot = join(root, "source");
  const extracted = join(root, "extracted");
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Acceptance fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: sourceRoot }
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    await mkdir(join(sourceRoot, "src"), { recursive: true });
    await Bun.write(
      join(sourceRoot, "src/main.ts"),
      "export const fixture = 1;\n"
    );
    await symlink("main.ts", join(sourceRoot, "src/link.ts"));
    git("init", "--quiet");
    git("add", ".");
    git("commit", "--quiet", "-m", "synthetic source fixture");
    const commit = git("rev-parse", "HEAD");
    expect(
      (await verifyAcceptanceSource({ sourceRoot }, commit)).sourceRoot
    ).toBe(sourceRoot);
    const path = join(root, "source.tar");
    git("archive", "--format=tar", `--output=${path}`, "HEAD");
    const archive = await Bun.file(path).arrayBuffer();
    const sha256 = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
    await new Bun.Archive(archive).extract(extracted);
    const settings = { sourceRoot: extracted, sourceArchive: { path, sha256 } };
    await utimes(join(extracted, "src/main.ts"), new Date(), new Date());
    expect((await verifyAcceptanceSource(settings, commit)).sourceRoot).toBe(
      extracted
    );
    await Bun.write(
      join(sourceRoot, "src/main.ts"),
      "export const fixture = 2;\n"
    );
    await expect(
      verifyAcceptanceSource({ sourceRoot }, commit)
    ).rejects.toThrow("Source differs from pinned Git commit");
    await Bun.write(
      join(extracted, "src/main.ts"),
      "export const fixture = 2;\n"
    );
    await expect(verifyAcceptanceSource(settings, commit)).rejects.toThrow(
      "Source tree differs from archive"
    );
    await Bun.write(
      join(extracted, "src/main.ts"),
      "export const fixture = 1;\n"
    );
    await unlink(join(extracted, "src/link.ts"));
    await symlink("wrong.ts", join(extracted, "src/link.ts"));
    await expect(verifyAcceptanceSource(settings, commit)).rejects.toThrow(
      "Source tree differs from archive"
    );
    await expect(
      verifyAcceptanceSource(
        { ...settings, sourceArchive: { path, sha256: "0".repeat(64) } },
        commit
      )
    ).rejects.toThrow("Source archive hash mismatch");
    await expect(
      verifyAcceptanceSource(settings, "0".repeat(40))
    ).rejects.toThrow("Source archive commit mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
